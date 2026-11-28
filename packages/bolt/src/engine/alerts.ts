// Local workspace operational alerts: configured in Command Center → Alerts, persisted in `sys_config`,
// delivered to active workspace administrators' Inbox and/or configured email recipients via the host's
// transactional mail port, with per-key repeat cooldowns adopting the same mechanism as Colony alerts.
import { Clock, Context, Crypto, Effect, Layer, Option, Ref, Schema } from 'effect';
import { Port } from '@norbital-ai/host-api';
import { BoltError } from '../protocol/errors.ts';
import { under } from '../protocol/wire.ts';
import { LIMITS } from './contracts.ts';
import { CapturedResult, nativeCommit } from './db/captured.ts';
import { TenantDb, type TenantDbShape } from './db/tenant-db.ts';
import type { EngineError } from './errors.ts';
import { noticePiece } from './notifications/queue.ts';
import { uuid } from './port.ts';
import { Transport } from './ports.ts';
import { isDeliverableEmail } from './runs/mail.ts';
import { next_due } from './runs/queue.ts';
import { Activation, Live, Wake } from './services.ts';
import { Chain } from './write/sql.ts';
import { agentSettings, spent } from './agent/settings.ts';

export const ALERTS_KEY = 'alerts';
const ALERTS_COOLDOWN_KEY = 'alerts.cooldown';
const ALERTS_HISTORY_KEY = 'alerts.history';
const MAX_HISTORY = 25;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const WorkspaceAlerts = Schema.Struct({
	enabled: Schema.Boolean,
	emails: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
	notify_admins: Schema.Boolean,
	cooldown_minutes: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(1),
		Schema.isLessThanOrEqualTo(1440)
	),
	automation_failed: Schema.Boolean,
	integration_failed: Schema.Boolean,
	ai_spend_threshold_pct: Schema.NullOr(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(100)
		)
	)
});
export type WorkspaceAlerts = typeof WorkspaceAlerts.Type;

export const DEFAULT_WORKSPACE_ALERTS: WorkspaceAlerts = {
	enabled: false,
	emails: [],
	notify_admins: true,
	cooldown_minutes: 60,
	automation_failed: true,
	integration_failed: true,
	ai_spend_threshold_pct: 80
};

export const WorkspaceAlertKind = Schema.Literals([
	'automation',
	'integration',
	'ai_spend',
	'test'
]);
export type WorkspaceAlertKind = typeof WorkspaceAlertKind.Type;

export const WorkspaceAlertEvent = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	kind: WorkspaceAlertKind,
	key: Schema.String,
	title: Schema.String,
	detail: Schema.String,
	emailed: Schema.Array(Schema.String),
	inbox: Schema.Number
});
export type WorkspaceAlertEvent = typeof WorkspaceAlertEvent.Type;

export const WorkspaceAlertsState = Schema.Struct({
	settings: WorkspaceAlerts,
	history: Schema.Array(WorkspaceAlertEvent),
	ai_monthly_cap: Schema.NullOr(Schema.Number),
	ai_monthly_spent: Schema.Number,
	admin_emails: Schema.Array(Schema.String)
});
export type WorkspaceAlertsState = typeof WorkspaceAlertsState.Type;

export const WorkspaceAlertTestResult = Schema.Struct({
	sent: Schema.Boolean,
	emailed: Schema.Array(Schema.String),
	inbox: Schema.Number,
	reason: Schema.optionalKey(Schema.String)
});
export type WorkspaceAlertTestResult = typeof WorkspaceAlertTestResult.Type;

export type WorkspaceAlertsShape = Readonly<{
	readonly state: Effect.Effect<WorkspaceAlertsState, EngineError>;
	readonly save: (next: WorkspaceAlerts) => Effect.Effect<WorkspaceAlerts, EngineError>;
	readonly sendTest: (
		operatorEmail: string | null
	) => Effect.Effect<WorkspaceAlertTestResult, EngineError>;
	readonly automationFailed: (
		event: Readonly<{ automation: string; runId: string; message: string }>
	) => Effect.Effect<void>;
	readonly integrationFailed: (
		event: Readonly<{ source: string; key: string; detail: string }>
	) => Effect.Effect<void>;
	readonly checkAiSpend: Effect.Effect<void>;
}>;

export class WorkspaceAlertsService extends Context.Service<
	WorkspaceAlertsService,
	WorkspaceAlertsShape
>()('bolt/WorkspaceAlerts') {}

const CooldownMap = Schema.Record(Schema.String, Schema.Number);
const HistoryList = Schema.Array(WorkspaceAlertEvent);
const AdminRow = Schema.Struct({
	id: Schema.String,
	email: Schema.NullOr(Schema.String)
});
const WorkspaceRow = Schema.Struct({ name: Schema.NullOr(Schema.String) });

const readConfig = <A>(db: TenantDbShape, key: string, schema: Schema.Decoder<A>, fallback: A) =>
	db
		.one(Schema.Struct({ value: Schema.fromJsonString(schema) }), {
			text: 'SELECT value FROM sys_config WHERE key = $1',
			params: [key]
		})
		.pipe(
			Effect.map((row) =>
				Option.match(row, { onNone: () => fallback, onSome: (found) => found.value })
			),
			Effect.catch(() => Effect.succeed(fallback))
		);

const writeConfig = (db: TenantDbShape, key: string, value: unknown) =>
	db.write({
		text: `INSERT INTO sys_config (key, value) VALUES ($1, $2)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		params: [key, JSON.stringify(value)]
	});

const normalizeEmails = (emails: readonly string[]): readonly string[] => {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of emails) {
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
};

const cleanLine = (value: string) => value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();

const escapeHtml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

const renderAlertMail = (workspace: string, title: string, detail: string, link: string) => {
	const brand = cleanLine(workspace) || 'Norbital Workspace';
	const heading = cleanLine(title);
	const subject = `[${brand} Alert] ${heading}`;
	const text = [heading, '', detail, '', `Open Command Center: ${link}`].join('\n');
	const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:24px 28px 0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#18181b">${escapeHtml(brand)} · Alert</td></tr>
<tr><td style="padding:14px 28px 8px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:17px;font-weight:600;line-height:24px;color:#18181b">${escapeHtml(heading)}</td></tr>
<tr><td style="padding:4px 28px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#3f3f46;white-space:pre-line">${escapeHtml(detail)}</td></tr>
<tr><td style="padding:8px 28px 24px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;font-weight:500">Open Command Center</a></td></tr>
</table></td></tr></table></body></html>`;
	return { subject, text, html };
};

export const workspaceAlerts = (db: TenantDbShape) =>
	readConfig(db, ALERTS_KEY, WorkspaceAlerts, DEFAULT_WORKSPACE_ALERTS);

export const saveWorkspaceAlerts = Effect.fn('Alerts.save')(function* (
	db: TenantDbShape,
	next: WorkspaceAlerts
) {
	const normalizedEmails = normalizeEmails(next.emails);
	const bad = normalizedEmails.find((email) => !EMAIL_PATTERN.test(email));
	if (bad !== undefined)
		return yield* BoltError.make(
			'invalid_input',
			'decode',
			`Invalid alert recipient email address: ${bad}`
		);
	if (next.enabled && !next.notify_admins && normalizedEmails.length === 0)
		return yield* BoltError.make(
			'invalid_input',
			'decode',
			'Enable admin inbox alerts or add at least one email recipient.'
		);
	const cleaned: WorkspaceAlerts = { ...next, emails: [...normalizedEmails] };
	yield* writeConfig(db, ALERTS_KEY, cleaned);
	return cleaned;
});

export const WorkspaceAlertsLive = Layer.effect(
	WorkspaceAlertsService,
	Effect.gen(function* () {
		const db = yield* TenantDb,
			transport = yield* Transport,
			live = yield* Live,
			wake = yield* Wake,
			activation = yield* Activation,
			crypto = yield* Crypto.Crypto;
		const localCooldowns = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

		const activeAdmins = () =>
			db.rows(AdminRow, {
				text: `SELECT id, email FROM sys_user WHERE active AND admin AND kind = 'staff' ORDER BY id`,
				params: []
			});

		const workspaceName = () =>
			db
				.rows(WorkspaceRow, { text: 'SELECT name FROM sys_workspace LIMIT 1', params: [] })
				.pipe(Effect.map((rows) => rows[0]?.name ?? ''));

		const deliver = Effect.fn('WorkspaceAlerts.deliver')(function* (input: Readonly<{
			kind: WorkspaceAlertKind;
			key: string;
			title: string;
			detail: string;
			settings: WorkspaceAlerts;
			bypassCooldown?: boolean;
		}>) {
			const now = yield* Clock.currentTimeMillis;
			const at = new Date(now).toISOString();
			const cooldownMillis = input.settings.cooldown_minutes * 60_000;

			if (input.bypassCooldown !== true) {
				// Fast in-memory check first, then durable sys_config check so restarts preserve cooldowns.
				const memoryHeld = yield* Ref.get(localCooldowns);
				const recent = memoryHeld.get(input.key);
				if (recent !== undefined && now - recent < cooldownMillis) return null;
				const storedCooldowns = yield* readConfig(db, ALERTS_COOLDOWN_KEY, CooldownMap, {});
				const storedAt = storedCooldowns[input.key];
				if (storedAt !== undefined && now - storedAt < cooldownMillis) {
					yield* Ref.update(localCooldowns, (prev) => {
						const next = new Map(prev);
						next.set(input.key, storedAt);
						return next;
					});
					return null;
				}
				const claimed = yield* Ref.modify(localCooldowns, (prev) => {
					const again = prev.get(input.key);
					if (again !== undefined && now - again < cooldownMillis) return [false, prev] as const;
					const next = new Map(prev);
					next.set(input.key, now);
					return [true, next] as const;
				});
				if (!claimed) return null;
				const nextCooldowns: Record<string, number> = {};
				const cutoff = now - 7 * 86_400_000;
				for (const [k, ts] of Object.entries(storedCooldowns)) {
					if (ts >= cutoff) nextCooldowns[k] = ts;
				}
				nextCooldowns[input.key] = now;
				yield* writeConfig(db, ALERTS_COOLDOWN_KEY, nextCooldowns).pipe(
					Effect.tapCause(Effect.logWarning),
					Effect.ignore
				);
			}

			const [admins, name] = yield* Effect.all([activeAdmins(), workspaceName()]);
			const id = yield* uuid(crypto);
			const link = under(activation.public_url, '/command-center/alerts');

			// Explicit recipients take precedence; otherwise fall back to deliverable active admin emails when notify_admins is on.
			const explicit = normalizeEmails(input.settings.emails);
			const emailTargets =
				explicit.length > 0
					? explicit
					: input.settings.notify_admins
						? normalizeEmails(
								admins.flatMap((a) =>
									a.email !== null && isDeliverableEmail(a.email) ? [a.email] : []
								)
							)
						: [];

			let inboxCount = 0;
			if (input.settings.notify_admins && admins.length > 0) {
				const c = new Chain();
				const rowPayload = JSON.stringify([
					{ id, at, title: input.title, body: input.detail }
				]);
				c.params.push(rowPayload);
				const inserted = noticePiece(
					c,
					'alert_notice',
					`INSERT INTO sys_notification (id, recipient, member, title, body, link, once, attachments, at)
					SELECT 'alert:' || e.id || ':' || u.id, '{"channel":"inbox","recipients":[]}'::jsonb, u.id,
						e.title, e.body, NULL, 'alert:' || e.id || ':' || u.id, '[]'::jsonb, e.at::timestamptz
					FROM jsonb_to_recordset($1::jsonb) AS e(id text, at text, title text, body text)
					CROSS JOIN sys_user u WHERE u.active AND u.admin AND u.kind = 'staff'
					ON CONFLICT (once) DO NOTHING`
				);
				const committed = yield* nativeCommit(
					db.write,
					live.publish,
					c,
					Schema.Struct({
						...CapturedResult.fields,
						count: Schema.Number,
						next_due: Schema.NullOr(Schema.String)
					}),
					`(SELECT count(*)::int FROM ${inserted}) AS count, ${next_due(c)}::text AS next_due`
				).pipe(Effect.tapCause(Effect.logWarning), Effect.catch(() => Effect.succeed(null)));
				if (committed !== null) {
					inboxCount = committed.count;
					if (committed.next_due !== null) yield* wake.at(committed.next_due);
				}
			}

			const emailed: string[] = [];
			let lastMailError: string | undefined;
			if (emailTargets.length > 0) {
				const rendered = renderAlertMail(name, input.title, input.detail, link);
				for (const recipient of emailTargets) {
					const sent = yield* transport
						.send({
							_tag: 'Mail',
							to: recipient,
							subject: rendered.subject,
							text: rendered.text,
							html: rendered.html,
							link
						})
						.pipe(Port.call('email', LIMITS.callMs.http), Effect.result);
					if (sent._tag === 'Success') {
						emailed.push(recipient);
					} else {
						const err = sent.failure;
						lastMailError = err._tag === 'Unavailable' ? err.reason : err.message;
						yield* Effect.logWarning('Workspace alert email delivery failed', {
							key: input.key,
							recipient,
							message: lastMailError
						});
					}
				}
			}

			const event: WorkspaceAlertEvent = {
				id,
				at,
				kind: input.kind,
				key: input.key,
				title: input.title,
				detail: input.detail,
				emailed,
				inbox: inboxCount
			};
			const history = yield* readConfig(db, ALERTS_HISTORY_KEY, HistoryList, []);
			yield* writeConfig(db, ALERTS_HISTORY_KEY, [event, ...history].slice(0, MAX_HISTORY)).pipe(
				Effect.tapCause(Effect.logWarning),
				Effect.ignore
			);
			return { event, lastMailError };
		});

		const state = Effect.gen(function* () {
			const [settings, history, agent, currentSpent, admins] = yield* Effect.all([
				workspaceAlerts(db),
				readConfig(db, ALERTS_HISTORY_KEY, HistoryList, []),
				agentSettings(db),
				spent(db, null),
				activeAdmins()
			]);
			const admin_emails = [
				...normalizeEmails(
					admins.flatMap((a) => (a.email !== null && isDeliverableEmail(a.email) ? [a.email] : []))
				)
			];
			return {
				settings,
				history,
				ai_monthly_cap: agent.monthly,
				ai_monthly_spent: currentSpent,
				admin_emails
			} satisfies WorkspaceAlertsState;
		});

		const save = (next: WorkspaceAlerts) => saveWorkspaceAlerts(db, next);

		const sendTest = Effect.fn('WorkspaceAlerts.sendTest')(function* (
			operatorEmail: string | null
		) {
			const settings = yield* workspaceAlerts(db);
			const now = yield* Clock.currentTimeMillis;
			const outcome = yield* deliver({
				kind: 'test',
				key: `test:${now}`,
				title: 'Test workspace alert',
				detail: [
					'This is a test alert triggered from the local Workspace Command Center.',
					`Triggered by: ${operatorEmail ?? 'Workspace administrator'}`,
					`Alerts active: ${settings.enabled ? 'Enabled' : 'Paused'}`,
					`Cooldown: ${settings.cooldown_minutes} min`
				].join('\n'),
				settings,
				bypassCooldown: true
			});
			if (outcome === null) {
				return {
					sent: false,
					emailed: [],
					inbox: 0,
					reason: 'Test alert could not be dispatched.'
				} satisfies WorkspaceAlertTestResult;
			}
			const sent = outcome.event.emailed.length > 0 || outcome.event.inbox > 0;
			return {
				sent,
				emailed: outcome.event.emailed,
				inbox: outcome.event.inbox,
				...(sent
					? {}
					: {
							reason:
								outcome.lastMailError ??
								'No active administrators or email recipients are configured.'
						})
			} satisfies WorkspaceAlertTestResult;
		});

		const automationFailed = Effect.fn('WorkspaceAlerts.automationFailed')(function* (
			event: Readonly<{ automation: string; runId: string; message: string }>
		) {
			const settings = yield* workspaceAlerts(db);
			if (!settings.enabled || !settings.automation_failed) return;
			yield* deliver({
				kind: 'automation',
				key: `automation:${event.automation}`,
				title: `Automation failed: ${event.automation}`,
				detail: [
					`Automation: ${event.automation}`,
					`Run: ${event.runId}`,
					...(event.message.trim().length > 0 ? [`Error: ${event.message.trim()}`] : [])
				].join('\n'),
				settings
			});
		});

		const integrationFailed = Effect.fn('WorkspaceAlerts.integrationFailed')(function* (
			event: Readonly<{ source: string; key: string; detail: string }>
		) {
			const settings = yield* workspaceAlerts(db);
			if (!settings.enabled || !settings.integration_failed) return;
			yield* deliver({
				kind: 'integration',
				key: event.key,
				title: `Integration failure: ${event.source}`,
				detail: event.detail.slice(0, 600),
				settings
			});
		});

		const checkAiSpend = Effect.gen(function* () {
			const settings = yield* workspaceAlerts(db);
			if (!settings.enabled || settings.ai_spend_threshold_pct === null) return;
			const agent = yield* agentSettings(db);
			if (agent.monthly === null || agent.monthly <= 0) return;
			const current = yield* spent(db, null);
			const ratio = current / agent.monthly;
			const thresholdRatio = settings.ai_spend_threshold_pct / 100;
			if (!Number.isFinite(ratio) || ratio < thresholdRatio) return;
			const month = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 7);
			const pct = Math.round(ratio * 1000) / 10;
			const reachedLimit = ratio >= 1;
			yield* deliver({
				kind: 'ai_spend',
				key: `${reachedLimit ? 'ai_limit' : 'ai_spend'}:${month}`,
				title: reachedLimit
					? `Workspace AI monthly budget reached (${pct}%)`
					: `Workspace AI spend crossed ${settings.ai_spend_threshold_pct}% (${pct}%)`,
				detail: [
					`Month: ${month} (UTC)`,
					`Spent: USD ${current.toFixed(4)} / USD ${agent.monthly.toFixed(2)} (${pct}%)`,
					`Configured alert threshold: ${settings.ai_spend_threshold_pct}%`
				].join('\n'),
				settings
			});
		});

		return WorkspaceAlertsService.of({
			state,
			save,
			sendTest,
			automationFailed: (event) =>
				automationFailed(event).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore),
			integrationFailed: (event) =>
				integrationFailed(event).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore),
			checkAiSpend: checkAiSpend.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		});
	})
);
