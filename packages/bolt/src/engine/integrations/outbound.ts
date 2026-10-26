// Outbound conversation messages: queued once, delivered in order, and reported through the sync inbox.
import { Clock, Effect, Layer, Option, Predicate, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Files } from '../ports.ts';
import {
	Activation,
	Links,
	Live,
	Manifest,
	Outbound,
	RunHandlers,
	Wake,
	type OutboundFile
} from '../services.ts';
import { Port } from '../port.ts';
import { iso, backoffMs } from '../runs/time.ts';
import { enqueue } from '../runs/queue.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Sql, Outcome } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { Unavailable } from '../../decl/errors.ts';
import { LIMITS } from '../contracts.ts';
import { Fenced, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Chain } from '../write/sql.ts';
import { msg } from '../conversations/store.ts';
import {
	RANK,
	SendRefused,
	sendRefusal,
	TERMINAL,
	type DeliveryEntry,
	type DeliveryReport
} from '../conversations/status.ts';
import { conversationOf, definitionOf } from './instances.ts';
import { reportRowsPiece } from '../sync/hint.ts';
/** The messages a conversation carries: chat (`{ to, text }`) or email. */
type ConversationKind = 'chat' | 'email';
/** The platform run that delivers every queued outbound row. */
export const DELIVER = 'integrations.deliver';
/** Where the environment's epoch is kept (`activate`): the host's, a fork's or a restore's own. */
const EPOCH_KEY = 'integrations.epoch';
/** The epoch new outbound rows carry; a row of another epoch (a fork, a restore) is never sent. */
export const EPOCH = `coalesce((SELECT value FROM sys_config WHERE key = '${EPOCH_KEY}'), '')`;
/** A new row's timeline: accepted by bolt, not yet handed to the provider (§5.9). */
export const QUEUED = (c: Chain, now: string) =>
	`jsonb_build_array(jsonb_build_object('kind', 'queued', 'at', ${c.p(now)}::text, 'provider', 'bolt'))`;
/** A statement's delivery run, queued when its `rows` piece inserted any. */
export const deliverRun = (c: Chain, rows: string, now: string) =>
	enqueue(c, [{ automation: DELIVER, input: {}, dueAt: now, cause: 'schedule', depth: 0 }], {
		when: `EXISTS (SELECT 1 FROM ${rows})`
	});
type Obj = {
	readonly [key: string]: Json;
};
const AttachmentRef = Schema.Record(Schema.String, Schema.Json)
	.check(
		Schema.makeFilter((value) =>
			typeof value['id'] === 'string' &&
			!('base64' in value) &&
			(value['bytes'] === undefined || typeof value['bytes'] === 'number')
				? undefined
				: 'attachments are stored file references, never inline bytes'
		)
	)
	.pipe(
		Schema.decodeTo(
			Schema.Struct({
				id: Schema.String,
				name: Schema.optionalKey(Schema.String),
				mime: Schema.optionalKey(Schema.String),
				size: Schema.optionalKey(Schema.Number),
				bytes: Schema.optionalKey(Schema.Number),
				sha256: Schema.optionalKey(Schema.String)
			})
		)
	);
const Attachments = Schema.optionalKey(Schema.Array(AttachmentRef));
const ChatInput = Schema.Record(Schema.String, Schema.Json)
	.check(
		Schema.makeFilter((value) =>
			typeof value['to'] === 'string' && value['to'] !== ''
				? undefined
				: 'a chat message needs `to`'
		),
		Schema.makeFilter((value) =>
			typeof value['text'] === 'string' ? undefined : 'a chat message needs `text`'
		)
	)
	.pipe(
		Schema.decodeTo(
			Schema.Struct({
				to: Schema.NonEmptyString,
				text: Schema.String,
				attachments: Attachments,
				thread: Schema.optionalKey(Schema.String),
				id: Schema.optionalKey(Schema.String)
			})
		)
	);
const MailInput = Schema.Struct({
	to: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	subject: Schema.String,
	text: Schema.optionalKey(Schema.String),
	html: Schema.optionalKey(Schema.String),
	attachments: Attachments,
	cc: Schema.optionalKey(Schema.Array(Schema.String)),
	bcc: Schema.optionalKey(Schema.Array(Schema.String)),
	thread: Schema.optionalKey(Schema.String),
	id: Schema.optionalKey(Schema.String),
	inReplyTo: Schema.optionalKey(Schema.String),
	references: Schema.optionalKey(Schema.Array(Schema.String))
}).check(
	Schema.makeFilter((value) =>
		value.text !== undefined || value.html !== undefined ? undefined : 'an email needs text or html'
	)
);
export const sendInputSchema = (kind: ConversationKind): Schema.Codec<Obj> =>
	kind === 'email' ? MailInput : ChatInput;
/** A timeline entry as stored: `raw` bounded to 4 KB. */
const entry = (e: DeliveryEntry): string => {
	const raw = e.raw === undefined ? undefined : JSON.stringify(e.raw);
	return JSON.stringify(
		raw === undefined || raw.length <= 4096 ? e : { ...e, raw: raw.slice(0, 4096) }
	);
};
/** The status after kind `k` in SQL, `statusAfter`'s rule (status.ts): terminal wins, `auto_replied` never moves it, else the higher rank. */
const AFTER = (
	col: string,
	k: string,
	t: string,
	r: string
) => `CASE WHEN ${k} = 'auto_replied' OR coalesce(${col}, '') IN (SELECT jsonb_array_elements_text(${t}::jsonb)) THEN ${col}
	WHEN ${k} IN (SELECT jsonb_array_elements_text(${t}::jsonb)) THEN ${k}
	WHEN (${r}::jsonb ->> ${k})::int > coalesce((${r}::jsonb ->> ${col})::int, 0) THEN ${k} ELSE ${col} END`;
const TERMINALS = JSON.stringify([...TERMINAL]),
	RANKS = JSON.stringify(RANK);
const MAX_ATTEMPTS = 8;
const LEASE = `interval '10 minutes'`;
/** A sync's queued sends wait until its id map and acknowledgement commit, so their reports have a destination. */
const RELEASED = (row: string) =>
	`(${row}.meta ->> 'sync_write' IS NULL OR EXISTS (SELECT 1 FROM sys_outbox o WHERE o.key = ${row}.meta ->> 'sync_write' AND o.status = 'acked'))`;
const sql = (text: string, ...params: Json[]) => ({ text, params });
type OutboundConfig = {
	engine: { manifest: EngineManifest; db: TenantDbShape; live: Live['Service'] };
	send: Links['Service']['send'];
	files: Files['Service'];
	announce: (at: string) => Effect.Effect<void>;
	epoch: string;
};
function makeOutbound(cfg: OutboundConfig) {
	const { manifest: m, db } = cfg.engine,
		epoch = cfg.epoch;
	const backoff = (now: string, attempts: number) =>
		new Date(Date.parse(now) + Math.min(backoffMs('1s', attempts), 300000)).toISOString();
	const mutateMessage = (statement: Sql, returning = '1 AS changed', event?: DeliveryEntry) => {
		const c = new Chain();
		c.params.push(...statement.params);
		const changed = msg(c, statement.text, returning);
		if (event !== undefined)
			reportRowsPiece(
				m,
				c,
				() => `SELECT r.integration::text AS instance, r.id::text AS message,
			${c.p(`report:${event.kind}:${event.at}`)} || ':' || r.id AS delivery,
			${c.p(event)}::jsonb || jsonb_build_object('message', r.id) AS body FROM ${changed} r WHERE r.before IS DISTINCT FROM r.status OR ${c.p(event.kind)} IN ('replied', 'auto_replied')`,
				event.at
			);
		return db
			.returning(
				Schema.Struct({
					messages: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
					guarded: Schema.Number
				}),
				c.sql(
					`coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM ${changed} r), '[]'::jsonb) AS messages`
				)
			)
			.pipe(
				Effect.flatMap((rows) =>
					rows[0] === undefined
						? Effect.fail(
								BoltError.make('internal', 'commit', 'A message mutation returned no summary')
							)
						: Effect.succeed(rows[0].messages)
				)
			);
	};
	const attachmentsOf = Effect.fn('Outbound.attachmentsOf')(function* (refs: readonly Json[]) {
		const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(AttachmentRef))(refs).pipe(
			Effect.mapError(() => new SendRefused('an attachment is a stored FileRef'))
		);
		const rows = yield* db.rows(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				mime: Schema.String,
				size: Schema.Number,
				key: Schema.String
			}),
			{
				text: `SELECT id, name, mime, size, key FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				params: [JSON.stringify(decoded.map((ref) => ref.id))]
			}
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		const total = rows.reduce((sum, row) => sum + row.size, 0),
			cap = LIMITS.messageAttachmentBytes;
		if (total > cap)
			return yield* Effect.fail(
				new SendRefused(
					`the attachments are ${(total / 2 ** 20).toFixed(1)} MiB, over the ${cap / 2 ** 20} MiB a message carries`
				)
			);
		let left = cap;
		const out: OutboundFile[] = [];
		for (const ref of decoded) {
			const row = byId.get(ref.id);
			if (row === undefined)
				return yield* Effect.fail(new SendRefused(`attachment ${ref.id} is not a stored file`));
			const bytes = yield* cfg.files.get(row.key, left);
			left -= bytes.byteLength;
			out.push({
				id: row.id,
				name: row.name,
				mime: row.mime,
				bytes,
				url: (expiresInS) => cfg.files.url(row.key, expiresInS)
			});
		}
		return out;
	});
	const message = Effect.fn('Outbound.message')(function* (r: Obj) {
		const instance = String(r['integration']),
			inst = Predicate.isObject(r['inst']) ? r['inst'] : {},
			now = iso(yield* Clock.currentTimeMillis);
		const name = String(inst['integration'] ?? ''),
			def = definitionOf(m, name);
		const email = def !== undefined && conversationOf(def)?.kind === 'email';
		const body = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
			r['message']
		).pipe(
			Effect.mapError(() =>
				BoltError.make('badAnswer', 'deliver', 'the outbound row has no message')
			)
		);
		const [refs] = yield* db.read([
			sql(
				`SELECT provider_id FROM sys_message WHERE conversation = $1 AND provider_id IS NOT NULL AND id <> $2 ORDER BY seq DESC LIMIT 50`,
				r['conversation'] ?? null,
				r['id'] ?? null
			)
		]);
		const references = (refs?.rows ?? []).map((x) => String(x['provider_id'])).reverse();
		const thread = String(r['conv_thread']),
			to = email ? {} : { to: thread };
		const wire: Obj = {
			...body,
			id: String(r['id']),
			...to,
			...(references.length === 0 ? {} : { inReplyTo: references.at(-1) ?? '', references })
		};
		const got = yield* Effect.gen(function* () {
			const attachments = body['attachments'];
			const attachmentRefs = EffectArray.isArray<typeof attachments>(attachments)
				? attachments
				: [];
			const files = yield* attachmentsOf(attachmentRefs);
			return yield* cfg.send(instance, wire, files);
		}).pipe(Port.call('link', LIMITS.callMs.http), Effect.result);
		const attempts = Number(r['attempts']);
		if (got._tag === 'Success') {
			const receipt = got.success;
			const presume =
				'presumeAfterMs' in receipt &&
				typeof receipt.presumeAfterMs === 'number' &&
				receipt.presumeAfterMs > 0
					? new Date(Date.parse(now) + receipt.presumeAfterMs).toISOString()
					: null;
			yield* mutateMessage(
				sql(
					`UPDATE sys_message SET status = 'sent', provider_id = $2, sent_at = $3::timestamptz, error = NULL, presume_at = $4::timestamptz,
				delivery = delivery || jsonb_build_array($5::jsonb) WHERE id = $1`,
					r['id'] ?? null,
					receipt.providerId,
					now,
					presume,
					entry({ kind: 'sent', at: now, provider: 'bolt' })
				),
				'id, integration, NULL::text AS before, status',
				{ kind: 'sent', at: now, provider: 'bolt' }
			);
			yield* cfg.announce(now);
			return 'sent';
		}
		const cause = got.failure,
			refusal = sendRefusal(cause);
		const error = cause instanceof Error ? cause.message : String(cause);
		const fenced =
			cause instanceof Fenced || (cause instanceof BoltError && cause.code === 'fenced');
		const kind = fenced
			? 'fenced'
			: cause instanceof Unavailable
				? 'unavailable'
				: 'kind' in cause
					? cause.kind
					: cause instanceof BoltError
						? cause.code
						: 'upstream';
		const final =
			fenced ||
			refusal?.permanent === true ||
			kind === 'invalid' ||
			kind === 'unavailable' ||
			attempts >= MAX_ATTEMPTS;
		const status = !final ? 'queued' : kind === 'timeout' ? 'uncertain' : 'failed';
		// a retry is `deferred` on the timeline while the queue keeps the row `queued`; a timeout may have sent, so it records nothing
		const e: DeliveryEntry | null =
			status === 'uncertain'
				? null
				: {
						kind: status === 'queued' ? 'deferred' : 'failed',
						at: now,
						provider: 'bolt',
						reason: error.slice(0, 500),
						permanent: status === 'failed',
						...(fenced
							? { code: 'fenced' }
							: refusal?.code === undefined
								? {}
								: { code: refusal.code })
					};
		yield* mutateMessage(
			sql(
				`UPDATE sys_message SET status = $2, error = $3, next_attempt_at = $4::timestamptz, delivery = delivery || coalesce($5::jsonb, '[]'::jsonb) WHERE id = $1`,
				r['id'] ?? null,
				status,
				error.slice(0, 2000),
				backoff(now, attempts),
				e === null ? null : `[${entry(e)}]`
			),
			'id, integration, NULL::text AS before, status',
			// The first retry and a final failure reach the sync's next read, atomically with the message status.
			e !== null && (status === 'failed' || attempts === 1) ? e : undefined
		);
		if (e !== null && (status === 'failed' || attempts === 1)) yield* cfg.announce(now);
		return status === 'queued' ? 'retry' : status;
	});
	const deliver = Effect.fn('Outbound.deliver')(function* () {
		let sent = 0,
			failed = 0;
		const cleanup = new Chain();
		const skipped = msg(
			cleanup,
			`UPDATE sys_message SET status = 'skipped', error = 'queued in another environment epoch'
            WHERE direction = 'outbound' AND status IN ('queued', 'sending') AND coalesce(epoch, '') <> ${cleanup.p(epoch)}`,
			'1 AS changed'
		);
		const personal = msg(
			cleanup,
			`UPDATE sys_message SET status = 'failed', error = 'a personal account never sends'
            WHERE direction = 'outbound' AND status IN ('queued', 'sending') AND integration IN (SELECT id FROM sys_integration WHERE owner IS NOT NULL)`,
			'1 AS changed'
		);
		const refused = msg(
			cleanup,
			`UPDATE sys_message s SET status = 'skipped', error = 'the sync write was refused'
			WHERE s.direction = 'outbound' AND s.status = 'queued' AND EXISTS
			(SELECT 1 FROM sys_outbox o WHERE o.key = s.meta ->> 'sync_write' AND o.status IN ('failed', 'skipped'))`,
			'1 AS changed'
		);
		yield* db.write(
			cleanup.sql(
				`(SELECT count(*) FROM ${skipped}) + (SELECT count(*) FROM ${personal}) + (SELECT count(*) FROM ${refused}) AS n`
			)
		);
		for (let round = 0; round < 1000; round++) {
			const now = iso(yield* Clock.currentTimeMillis);
			const claimed = yield* mutateMessage(
				sql(
					`UPDATE sys_message s SET status = 'sending', attempts = s.attempts + 1, claimed_at = $1::timestamptz
				WHERE s.direction = 'outbound' AND s.integration IS NOT NULL AND s.message IS NOT NULL AND s.conversation IS NOT NULL
					AND ((s.status = 'queued' AND s.next_attempt_at <= $1::timestamptz) OR (s.status = 'sending' AND s.claimed_at < $1::timestamptz - ${LEASE}))
					AND EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = s.integration AND i.active)
					AND ${RELEASED('s')}
					AND NOT EXISTS (SELECT 1 FROM sys_message p WHERE p.integration = s.integration AND p.direction = 'outbound' AND p.status IN ('queued', 'sending') AND p.seq < s.seq
						AND p.conversation = s.conversation)`,
					now
				),
				`s.id, s.integration, s.conversation, s.message, s.attempts,
					(SELECT thread FROM sys_conversation c WHERE c.id = s.conversation) AS conv_thread,
					(SELECT jsonb_build_object('integration', i.integration, 'configuration', i.configuration) FROM sys_integration i WHERE i.id = s.integration) AS inst`
			);
			if (claimed.length === 0) break;
			for (const r of claimed) {
				const x = yield* message(r);
				if (x === 'sent') sent++;
				else if (x !== 'retry') failed++;
			}
		}
		// a quiet window passed with no delivered, bounced or failed report: delivered, presumed
		// ponytail: unindexed scan of outbound rows with a presume_at; add a partial index when outbound volume makes it show
		const now = iso(yield* Clock.currentTimeMillis);
		const [quiet] = yield* db.read([
			sql(
				`SELECT id FROM sys_message WHERE direction = 'outbound' AND presume_at <= $1::timestamptz
			AND status IN ('sent', 'deferred') ORDER BY presume_at LIMIT 1000`,
				now
			)
		]);
		for (const r of quiet?.rows ?? [])
			yield* record('id = $1', [r['id'] ?? null], {
				kind: 'delivered',
				at: now,
				provider: 'bolt',
				presumed: true
			});
		const [next] = yield* db.read([
			sql(`SELECT least(min(next_attempt_at) FILTER (WHERE status = 'queued'), min(presume_at) FILTER (WHERE status IN ('sent', 'deferred')))::text AS due
			FROM sys_message s WHERE direction = 'outbound' AND (status = 'queued' OR presume_at IS NOT NULL) AND ${RELEASED('s')}`)
		]);
		const due = next?.rows[0]?.['due'];
		if (
			typeof due === 'string' &&
			Date.parse(due) > Date.parse(iso(yield* Clock.currentTimeMillis))
		) {
			const at = new Date(due).toISOString();
			const c = new Chain();
			enqueue(
				c,
				[
					{
						automation: DELIVER,
						input: {},
						dueAt: at,
						key: `${DELIVER}@${at}`,
						cause: 'schedule',
						depth: 0
					}
				],
				{ conflict: 'keep' }
			);
			yield* db.write(c.sql('NULL AS outcome'));
			yield* cfg.announce(at);
		}
		return { sent, failed };
	});
	const record = Effect.fn('Outbound.record')(function* (
		where: string,
		params: readonly Json[],
		e: DeliveryEntry,
		extra: Obj = {}
	) {
		const n = params.length,
			$ = (i: number) => `$${n + i}`;
		const same = JSON.stringify([
			{ kind: e.kind, at: e.at, ...(e.code === undefined ? {} : { code: e.code }) }
		]);
		const res = yield* mutateMessage(
			sql(
				`WITH cur AS (SELECT id, status FROM sys_message WHERE ${where} AND direction = 'outbound' AND NOT delivery @> ${$(2)}::jsonb
				ORDER BY seq DESC LIMIT 1 FOR UPDATE)
			UPDATE sys_message s SET delivery = s.delivery || jsonb_build_array(${$(1)}::jsonb), status = ${AFTER('s.status', `${$(3)}::text`, $(4), $(5))},
				error = CASE WHEN ${$(3)} IN ('bounced', 'failed', 'complained', 'deferred') THEN coalesce(${$(6)}, s.error) ELSE s.error END,
				presume_at = CASE WHEN ${$(3)} IN ('sent', 'deferred', 'auto_replied') THEN s.presume_at END
			FROM cur WHERE s.id = cur.id`,
				...params,
				entry(e),
				same,
				e.kind,
				TERMINALS,
				RANKS,
				e.reason ?? null
			),
			's.id, s.integration, cur.status AS before, s.status',
			{ ...e, ...extra }
		);
		if (res.length > 0) yield* cfg.announce(e.at);
		return null;
	});

	return {
		deliver,
		activate: Effect.fn('Outbound.activate')(function* () {
			const current = yield* db.value(Schema.String, sql(`SELECT ${EPOCH} AS epoch`));
			if (current === epoch) return;
			yield* db.write(
				sql(
					`INSERT INTO sys_config (key, value) VALUES ('${EPOCH_KEY}', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
					epoch
				)
			);
		}),
		/** A provider's report on a message an instance sent, by the id its `send` answered (§5.9). */
		delivered: (
			instance: string,
			providerId: string,
			report: DeliveryReport
		): Effect.Effect<Option.Option<Outcome>, EngineError> =>
			record(
				'integration = $1 AND provider_id = $2',
				[instance, providerId],
				report.reason === undefined && (report.kind === 'bounced' || report.kind === 'failed')
					? { ...report, reason: report.code ?? report.kind }
					: report
			).pipe(Effect.map(Option.fromNullishOr)),
		/**
		 * A reply matched to its sending row by the outbound message's provider id or `thread` (an email's references, a
		 * chat's quoted message; rule 61); an automatic answer (RFC 3834) is `auto_replied`: recorded, never a reply.
		 */
		replied: (
			instance: string,
			refs: readonly string[],
			reply: {
				row: string;
				at: string;
				auto: boolean;
				message: Json;
			}
		): Effect.Effect<Option.Option<Outcome>, EngineError> =>
			record(
				`integration = $1 AND (provider_id IN (SELECT jsonb_array_elements_text($2::jsonb)) OR thread IN (SELECT jsonb_array_elements_text($2::jsonb)))`,
				[instance, JSON.stringify(refs)],
				{
					kind: reply.auto ? 'auto_replied' : 'replied',
					at: reply.at,
					provider: 'bolt',
					reply: reply.row
				},
				{ reply: reply.message }
			).pipe(Effect.map(Option.fromNullishOr)),
		/** The platform run the outbound pieces queue (rule 48): `runs.platform`. */
		handlers: { [DELIVER]: (_input: Json) => deliver() }
	};
}

export const OutboundLive = Layer.effect(
	Outbound,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			files = yield* Files,
			wake = yield* Wake,
			activation = yield* Activation,
			links = yield* Links,
			registry = yield* RunHandlers;
		const service = makeOutbound({
			engine: { manifest, db, live },
			send: links.send,
			files,
			announce: wake.at,
			epoch: activation.epoch
		});
		yield* registry.register(service.handlers);
		return { ...service, deliver: service.deliver(), activate: service.activate() };
	})
);
