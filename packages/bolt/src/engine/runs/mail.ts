import { Effect, Schema } from 'effect';
import { TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { Transport } from '../ports.ts';
import { Activation, type RunHandler } from '../services.ts';
import { type FacilityFailure, Port } from '@norbital-ai/host-api';
import { BoltError } from '../../protocol/errors.ts';
import { notice_path, under } from '../../protocol/wire.ts';

const Input = Schema.Struct({ ids: Schema.Array(Schema.String) });
const NoticeRow = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	link: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })),
	email: Schema.String
});
const WorkspaceRow = Schema.Struct({ name: Schema.NullOr(Schema.String) });

/** RFC 2606 reserved domains never route to a real mailbox; skip them so live mail providers do not bounce. */
const PLACEHOLDER_DOMAIN = /(?:^|\.)(?:invalid|example|test|localhost|example\.(?:com|net|org))$/i;

export const isDeliverableEmail = (email: string): boolean => {
	const at = email.lastIndexOf('@');
	if (at <= 0 || at === email.length - 1) return false;
	return !PLACEHOLDER_DOMAIN.test(email.slice(at + 1).trim());
};

const escapeHtml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

const cleanLine = (value: string) => value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();

const renderNoticeMail = (
	workspace: string,
	title: string,
	body: string | null,
	link: string
) => {
	const brand = cleanLine(workspace) || 'Norbital';
	const heading = cleanLine(title);
	const subject = `[${brand}] ${heading}`;
	const text = [heading, ...(body ? [body] : []), `Open: ${link}`].join('\n\n');
	const escapedBrand = escapeHtml(brand);
	const escapedTitle = escapeHtml(heading);
	const escapedBody = body ? escapeHtml(body).replaceAll('\n', '<br>') : null;
	const escapedLink = escapeHtml(link);
	const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapedTitle}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:28px 32px 0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#18181b">${escapedBrand}</td></tr>
<tr><td style="padding:20px 32px 8px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:17px;font-weight:600;line-height:24px;color:#18181b">${escapedTitle}</td></tr>
${escapedBody === null ? '' : `<tr><td style="padding:4px 32px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#3f3f46">${escapedBody}</td></tr>`}
<tr><td style="padding:12px 32px 28px"><a href="${escapedLink}" style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:500">Open in workspace</a></td></tr>
</table></td></tr></table></body></html>`;
	return { subject, text, html };
};

/** Emails each inbox notification whose notice asked for email (`via: ['email']`) via the host's transactional mail port. */
export const notice_mail = Effect.gen(function* () {
	const db = yield* TenantDb,
		transport = yield* Transport,
		activation = yield* Activation;
	const run: RunHandler = (input) =>
		Effect.gen(function* () {
			const body = yield* Schema.decodeUnknownEffect(Input)(input).pipe(
				Effect.mapError(() =>
					BoltError.make('invalid_input', 'decode', 'a mail notice run needs notice ids')
				)
			);
			if (body.ids.length === 0) return { sent: 0, failed: 0 };
			const [rows, workspaces] = yield* Effect.all([
				db.rows(NoticeRow, {
					text: `SELECT n.id, n.title, n.body, n.link, u.email
FROM sys_notification n
JOIN sys_user u ON u.id = n.member AND u.active AND u.email IS NOT NULL AND u.email <> ''
WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb))
ORDER BY u.id, n.id`,
					params: [JSON.stringify(body.ids)]
				}),
				db.rows(WorkspaceRow, { text: 'SELECT name FROM sys_workspace LIMIT 1', params: [] })
			]);
			const workspaceName = workspaces[0]?.name ?? '';
			let sent = 0,
				failed = 0,
				transient = 0;
			let retry: FacilityFailure | undefined;
			for (const row of rows) {
				if (!isDeliverableEmail(row.email)) continue;
				const link = under(activation.public_url, notice_path(row.link));
				const rendered = renderNoticeMail(workspaceName, row.title, row.body, link);
				const result = yield* transport
					.send({
						_tag: 'Mail',
						to: row.email,
						subject: rendered.subject,
						text: rendered.text,
						html: rendered.html,
						link
					})
					.pipe(Port.call('email', LIMITS.callMs.http), Effect.result);
				if (result._tag === 'Success') sent++;
				else {
					failed++;
					const error = result.failure;
					if (
						error._tag === 'FacilityFailure' &&
						(error.kind === 'upstream' || error.kind === 'timeout' || error.kind === 'rate_limited')
					) {
						transient++;
						retry ??= error;
					}
					yield* Effect.logWarning('Inbox email delivery failed', {
						notice: row.id,
						kind: error._tag === 'Unavailable' ? 'unavailable' : error.kind,
						message: error.message,
						...(error._tag === 'FacilityFailure' && error.status !== undefined
							? { status: error.status }
							: {})
					});
				}
			}
			if (retry !== undefined)
				return yield* BoltError.make(
					retry.kind,
					'facility',
					`Inbox email: ${sent} accepted, ${failed - transient} permanent failures, ${transient} transient failures.`,
					{ sent, failed, transient, failure: retry }
				);
			return { sent, failed };
		});
	return run;
});
