// Notifications as code (spec §2.2): a model's `notify` receives each write or approval event after the commit, as the
// queued platform run `bolt.notify`, reads the workspace, and returns notices; `ctx.notify` takes the same shape. Every
// notice reaches the in-app inbox of its recipients, and each `via` connection gets one delivery row (write/sql.ts
// `noticeInsert`). A notice never delays or fails the write that caused it.
import { Clock, Effect, Predicate, Schema } from 'effect';
import { localOf } from '@norbital-ai/std/zone';
import { CONVERT_TARGETS, LIMITS, type Invocation, type QueuedRun } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Guest, Live, Manifest, Wake, type RunHandler } from '../services.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Chain, noticeCaptures, noticeInsert } from '../write/sql.ts';
import { CommitAnswer } from '../write/commit.ts';
import { transformBridge } from '../write/act.ts';
import { nextDue } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { convertDocument } from '../facilities.ts';
import { Snapshot } from '../approvals/snapshot.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';

export const NOTIFY = 'bolt.notify';

const Approvers = Schema.Struct({
	teams: Schema.Array(Schema.String),
	users: Schema.Array(Schema.String)
});
/** A `NotifyEvent` as JSON (decl/ctx.ts): what the `bolt.notify` run carries and the model's `notify` receives. */
export const NotifyWire = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('write'),
		action: Schema.String,
		records: Schema.Array(Schema.Json),
		previous: Schema.Array(Schema.NullOr(Schema.Json)),
		actor: Schema.Json
	}),
	Schema.Struct({
		kind: Schema.Literal('approval'),
		move: Schema.Literals([
			'request',
			'approve',
			'reject',
			'requestChanges',
			'resubmit',
			'supersede'
		]),
		step: Schema.Number,
		steps: Snapshot.fields.steps,
		done: Schema.Boolean,
		request: Schema.String,
		records: Schema.Array(Schema.Json),
		requester: Schema.NullOr(Schema.String),
		approvers: Approvers
	})
]);
export type NotifyWire = typeof NotifyWire.Type;
const NotifyInput = Schema.Struct({ model: Schema.String, event: NotifyWire });

/** H1: the queued run that hands `event` to `model`'s `notify` after the causing statement commits. */
export const notifyRun = (input: { model: string; event: NotifyWire }, now: string): QueuedRun => ({
	automation: NOTIFY,
	input,
	dueAt: now,
	cause: 'schedule',
	depth: 0
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
		{ readonly requester: string | null; readonly approvers: typeof Approvers.Type } | undefined;
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
				'invalidInput',
				'guest',
				`a notice is { title, description?, to: [recipient], via?, attachments?, link?, once? }: ${error.message}`,
				error
			)
		)
	);
	if (list.length > LIMITS.changesPerAct)
		return yield* Effect.fail(BoltError.make('tooLarge', 'guest', 'too many notices at once'));
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
				BoltError.make('invalidInput', 'guest', 'a notice names at least one recipient')
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
					'invalidInput',
					'guest',
					`a notice names ${JSON.stringify(unknown)}: no such team or policy in this workspace`
				)
			);
		for (const channel of notice.via ?? []) {
			const slot = ctx.manifest.connections[channel],
				definition = slot === undefined ? undefined : definitionOf(ctx.manifest, slot.integration);
			if (definition === undefined || conversationOf(definition) === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalidInput',
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

/** A document attachment converted (H5) into a file the `bolt.notify` run owns; a stored file stays as it is. */
const attached = (attachment: Attachment) =>
	'document' in attachment
		? convertDocument(attachment.document, {
				to: attachment.to,
				name: attachment.name,
				for: NOTIFY
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
	for (const row of rows) {
		if (!row.attachments.some((attachment) => 'document' in attachment)) continue;
		const attachments = yield* Effect.forEach(row.attachments, attached);
		yield* db.write({
			text: 'UPDATE sys_notification SET attachments = $2::jsonb WHERE id = $1 AND attachments = $3::jsonb',
			params: [row.id, JSON.stringify(attachments), JSON.stringify(row.attachments)]
		});
		live.syncChanged('sys_notification', [row.id]);
	}
});

/**
 * H1: the `bolt.notify` run handler. Invokes the model's `notify` with the event (guest kind `notify`, workspace reads,
 * no I/O), expands `'requester'`/`'approvers'` from an approval event, converts document attachments, and inserts the
 * notices in one statement keyed by the run, so a retried attempt delivers nothing twice.
 */
export const runNotify = Effect.gen(function* () {
	const m = yield* Manifest,
		db = yield* TenantDb,
		guest = yield* Guest,
		live = yield* Live,
		wake = yield* Wake,
		context = yield* Effect.context<Effect.Services<ReturnType<typeof convertDocument>>>();
	const run: RunHandler = (input, current) =>
		Effect.gen(function* () {
			const { model, event } = yield* Schema.decodeUnknownEffect(NotifyInput)(input).pipe(
				Effect.mapError((error) =>
					BoltError.make(
						'invalidInput',
						'decode',
						'a bolt.notify run carries { model, event }',
						error
					)
				)
			);
			// a release that dropped the model's `notify` since the event was queued
			if (m.exposures[model]?.notify !== true) return { notices: 0 };
			const now = iso(yield* Clock.currentTimeMillis);
			const invocation: Invocation = {
				id: current.id,
				run: current.id,
				kind: 'notify',
				target: model,
				input: event,
				ctx: {
					actor: { kind: 'system', run: current.id, by: { platform: NOTIFY } },
					now,
					today: localOf(Date.parse(now), m.workspace.tz).date,
					tz: m.workspace.tz,
					seed: current.id
				},
				budget: { crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes }
			};
			const result = yield* guest.invoke(invocation, transformBridge(m, db, invocation));
			if (result.kind === 'failed') return yield* Effect.fail(result.error);
			if (result.kind === 'refused')
				return yield* Effect.fail(BoltError.make('guestError', 'guest', result.message));
			const first = event.records[0];
			const record = !Array.isArray(first) && Predicate.hasProperty(first, 'id') ? first.id : null;
			const rows = yield* noticeRows(result.output, {
				manifest: m,
				id: event.kind === 'approval' ? `${event.request}:${current.id}` : current.id,
				link:
					typeof record === 'string' && (event.kind === 'approval' || event.records.length === 1)
						? { model, id: record }
						: undefined,
				approval:
					event.kind === 'approval'
						? { requester: event.requester, approvers: event.approvers }
						: undefined
			});
			if (rows.length === 0) return { notices: 0 };
			const delivered = new Set(
				(yield* db.rows(Schema.Struct({ id: Schema.String }), {
					text: `SELECT r.id FROM jsonb_to_recordset($1::jsonb) AS r(id text, once text)
				WHERE EXISTS (SELECT 1 FROM sys_notification n WHERE left(n.once, length(r.once) + 1) = r.once || ':')`,
					params: [JSON.stringify(rows)]
				})).map((row) => row.id)
			);
			const converted = yield* Effect.forEach(
				rows.filter((row) => !delivered.has(row.id)),
				(row) =>
					Effect.map(Effect.forEach(row.attachments, attached), (attachments): NoticeInsert => ({
						...row,
						attachments
					}))
			).pipe(Effect.provideContext(context));
			if (converted.length === 0) return { notices: 0 };
			const c = new Chain();
			noticeInsert(c, 'n', converted, now, 'true', m.teams, m.workspace.signup?.policies);
			const [answer] = yield* db.returning(
				Schema.Struct({
					captured: CommitAnswer.fields.captured,
					next_due: CommitAnswer.fields.next_due
				}),
				c.sql(`${noticeCaptures(c)} AS captured, ${nextDue(c)} AS next_due`)
			);
			if (answer !== undefined) {
				live.publish(answer.captured);
				if (answer.next_due !== null) yield* wake.at(answer.next_due);
			}
			return { notices: converted.length };
		});
	return run;
});
