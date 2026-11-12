// Effects and automations send notices through ctx.notify. Recipient expansion and attachment preparation
// belong here; the captured notice writer queues each inbox push and connection delivery with its inserted row.
import { Effect, Schema } from 'effect';
import { CONVERT_TARGETS, LIMITS } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Captured, CapturedResult, capturedFields, nativeCommit } from '../db/captured.ts';
import { Live, Wake } from '../services.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Chain } from '../write/sql.ts';
import { NOTICE_DELIVER, noticePiece } from './queue.ts';
import { next_due } from '../runs/queue.ts';
import { convertDocument } from '../facilities.ts';
import type { ApprovalRecipients } from '../../protocol/effect-events.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';

/** A workspace event as the host publishes it (a change merged, maintenance scheduled, a payment due): `at` is ISO. */
export type WorkspaceNote = {
	readonly id: string;
	readonly at: string;
	readonly title: string;
	readonly body?: string | undefined;
};
/** Workspace events as inbox notices to every active staff member, each once per member (a re-announce adds nothing). */
export const announce = Effect.fn('Bolt.announce')(function* (notes: readonly WorkspaceNote[]) {
	if (notes.length === 0) return;
	const db = yield* TenantDb,
		live = yield* Live,
		wake = yield* Wake;
	const c = new Chain();
	c.params.push(JSON.stringify(notes));
	noticePiece(c, 'announced', `INSERT INTO sys_notification (id, recipient, member, title, body, link, once, attachments, at)
	SELECT 'event:' || e.id || ':' || u.id, '{"channel":"inbox","recipients":[]}'::jsonb, u.id, e.title, e.body, NULL,
		'event:' || e.id || ':' || u.id, '[]'::jsonb, e.at::timestamptz
	FROM jsonb_to_recordset($1::jsonb) AS e(id text, at text, title text, body text)
	CROSS JOIN sys_user u WHERE u.active AND u.kind = 'staff'
	ON CONFLICT (once) DO NOTHING`);
	const result = yield* nativeCommit(db.write, live.publish, c,
		Schema.Struct({ ...CapturedResult.fields, next_due: Schema.NullOr(Schema.String) }),
		`${next_due(c)}::text AS next_due`);
	if (result.next_due !== null) yield* wake.at(result.next_due);
});

const Recipient = Schema.Union([
	Schema.Literals(['requester', 'approvers']),
	Schema.Struct({ team: Schema.NonEmptyString }),
	Schema.Struct({ user: Schema.NonEmptyString }),
	Schema.Struct({ policy: Schema.NonEmptyString })
]);
const Source = Schema.Union([
	Schema.Struct({ markdown: Schema.String }),
	Schema.Struct({ html: Schema.String })
]);
const Document = Schema.Struct({
	document: Source,
	to: Schema.Literals(CONVERT_TARGETS),
	name: Schema.String
});
const FileLink = Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String });
const Notice = Schema.Struct({
	title: Schema.String,
	description: Schema.optionalKey(Schema.String),
	to: Schema.Array(Recipient),
	via: Schema.optionalKey(Schema.Array(Schema.String)),
	attachments: Schema.optionalKey(Schema.Array(Schema.Union([FileLink, Document]))),
	link: Schema.optionalKey(Schema.Struct({ model: Schema.String, id: Schema.String })),
	once: Schema.optionalKey(Schema.String)
});
type Notice = typeof Notice.Type;
type Attachment = NonNullable<Notice['attachments']>[number];
/** A recipient the inbox fan-out matches: `'requester'` and `'approvers'` are expanded first. */
type Addressee = { team: string } | { user: string } | { policy: string };
/** One `noticeInsert` row. */
export type NoticeInsert = {
	id: string;
	to: readonly Addressee[];
	via: readonly string[];
	title: string;
	body: string | null;
	link: { model: string; id: string } | null;
	/** The dedupe key: the author's `once`, else the notice's own id, so a retried run inserts nothing twice. */
	once: string;
	attachments: readonly Attachment[];
};
export type NoticeContext = {
	readonly manifest: EngineManifest;
	/** The notices' id prefix, stable per event or call (`<prefix>:<index>`). */
	readonly id: string;
	/** Where a notice without `link` points. */
	readonly link?: { readonly model: string; readonly id: string } | undefined;
	/** An approval event's requester and current approvers; elsewhere `'requester'` and `'approvers'` reach nobody. */
	readonly approval?:
		{ readonly requester: string | null; readonly approvers: typeof ApprovalRecipients.Type } | undefined;
};

/** H1: notices as an author returns them (one or a list) → `noticeInsert` rows, recipients expanded and checked. */
export const noticeRows = Effect.fn('Bolt.noticeRows')(function* (
	notices: unknown,
	ctx: NoticeContext
) {
	const list = yield* Schema.decodeUnknownEffect(Schema.Array(Notice))(
		Array.isArray(notices) ? notices : [notices],
		{ onExcessProperty: 'error' }
	).pipe(
		Effect.mapError((error) =>
			BoltError.make(
				'invalid_input',
				'guest',
				`a notice is { title, description?, to: [recipient], via?, attachments?, link?, once? }: ${error.message}`,
				error
			)
		)
	);
	if (list.length > LIMITS.changesPerAct)
		return yield* Effect.fail(BoltError.make('too_large', 'guest', 'too many notices at once'));
	const channels = [...new Set(list.flatMap((notice) => notice.via ?? []))];
	const accounts = channels.length === 0 ? [] : yield* (yield* TenantDb).rows(
		Schema.Struct({ id: Schema.String, integration: Schema.String, owner: Schema.NullOr(Schema.String) }),
		{ text: 'SELECT id,integration,owner FROM sys_integration WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
			params: [JSON.stringify(channels)] }
	);
	const byId = new Map(accounts.map((account) => [account.id, account]));
	const requester = ctx.approval?.requester ?? null;
	const expand = (to: Notice['to'][number]): Addressee[] =>
		to === 'requester'
			? requester === null
				? []
				: [{ user: requester }]
			: to === 'approvers'
				? [
						...(ctx.approval?.approvers.teams ?? []).map((team) => ({ team })),
						...(ctx.approval?.approvers.users ?? []).map((user) => ({ user }))
					]
				: [to];
	const rows: NoticeInsert[] = [];
	for (const [index, notice] of list.entries()) {
		if (notice.to.length === 0)
			return yield* Effect.fail(
				BoltError.make('invalid_input', 'guest', 'a notice names at least one recipient')
			);
		const to = [...new Map(notice.to.flatMap(expand).map((r) => [JSON.stringify(r), r])).values()];
		const unknown = to.find(
			(r) =>
				('team' in r && !Object.hasOwn(ctx.manifest.teams, r.team)) ||
				('policy' in r && !Object.hasOwn(ctx.manifest.policies, r.policy))
		);
		if (unknown !== undefined)
			return yield* Effect.fail(
				BoltError.make(
					'invalid_input',
					'guest',
					`a notice names ${JSON.stringify(unknown)}: no such team or policy in this workspace`
				)
			);
		if (to.length === 0) continue;
		for (const channel of notice.via ?? []) {
			const account = byId.get(channel);
			const definition = account === undefined ? undefined : definitionOf(ctx.manifest, account.integration);
			if (account === undefined || account.owner !== null || definition === undefined || conversationOf(definition) === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalid_input',
						'guest',
						`A notice channel '${channel}' must name a conversation connection.`
					)
				);
		}
		const id = `${ctx.id}:${index}`;
		rows.push({
			id,
			to,
			via: [...new Set(notice.via ?? [])],
			title: notice.title,
			body: notice.description ?? null,
			link: notice.link ?? ctx.link ?? null,
			once: notice.once ?? id,
			attachments: notice.attachments ?? []
		});
	}
	return rows;
});

/** A document attachment converted (H5) into a file the notification delivery owns; a stored file stays as it is. */
const attached = (attachment: Attachment) =>
	'document' in attachment
		? convertDocument(attachment.document, {
				to: attachment.to,
				name: attachment.name,
				for: NOTICE_DELIVER
			}).pipe(
				Effect.map((file): Attachment => ({ id: file.id, name: file.name, mime: file.mime })),
				Effect.mapError((error) =>
					BoltError.make(
						error._tag === 'Unavailable' ? 'unavailable' : error.kind,
						'facility',
						error._tag === 'Unavailable' ? error.reason : error.message
					)
				)
			)
		: Effect.succeed(attachment);

/** Converts queued document attachments at inbox or channel delivery; retries reuse persisted file references. */
export const prepareNoticeFiles = Effect.fn('Bolt.prepareNoticeFiles')(function* (
	ids: readonly string[]
) {
	if (ids.length === 0) return;
	const db = yield* TenantDb,
		live = yield* Live;
	const rows = yield* db.rows(
		Schema.Struct({
			id: Schema.String,
			attachments: Schema.Array(Schema.Union([FileLink, Document]))
		}),
		{
			text: `SELECT id, coalesce(attachments, '[]'::jsonb) AS attachments FROM sys_notification WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(ids)]
		}
	);
	const converted = yield* Effect.forEach(
		rows.filter((row) => row.attachments.some((attachment) => 'document' in attachment)),
		(row) =>
			Effect.map(Effect.forEach(row.attachments, attached), (attachments) => ({
				id: row.id,
				attachments,
				before: row.attachments
			}))
	);
	if (converted.length === 0) return;
	// every converted notice in one statement, each only while it still holds the attachments read
	const captured = yield* db.returning(Captured, {
		text: `UPDATE sys_notification n SET attachments = v.attachments FROM jsonb_to_recordset($1::jsonb) AS v(id text, attachments jsonb, before jsonb)
	WHERE n.id = v.id AND n.attachments = v.before RETURNING ${capturedFields("'sys_notification'")}`,
		params: [JSON.stringify(converted)]
	});
	live.publish(captured);
});

