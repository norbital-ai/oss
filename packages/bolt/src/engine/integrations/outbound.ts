// Outbound conversation messages: queued once, delivered in order, and reported through the sync inbox.
import { sql } from '../db/sql.ts';
import { Clock, Effect, Layer, Predicate, Result, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
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
import { iso } from '../runs/time.ts';
import { ClaimToken, claim_matches, claimedBy, claimSql, leaseExpiry, renewClaims, retryDelay } from '../queue.ts';
import { enqueueDrain } from '../runs/queue.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Sql } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { FacilityFailure, Unavailable } from '../../decl/errors.ts';
import { LIMITS } from '../contracts.ts';
import { Fenced, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Chain } from '../write/sql.ts';
import { msg } from '../conversations/store.ts';
import {
	RANK,
	OutboundReference,
	SendRefused,
	sendRefusal,
	TERMINAL,
	type DeliveryEntry,
	type DeliveryReport
} from '../conversations/status.ts';
import { conversationOf, definitionOf } from './instances.ts';
import { reportRowsPiece } from '../sync/hint.ts';
import { LINK_DOWN } from './abi.ts';
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
	enqueueDrain(c, DELIVER, c.p(now), `EXISTS (SELECT 1 FROM ${rows})`);
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
const Common = {
	reply_to: Schema.optionalKey(Schema.NonEmptyString),
	about: Schema.optionalKey(Schema.Struct({ model: Schema.NonEmptyString, id: Schema.NonEmptyString }))
};
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
				...Common,
				to: Schema.NonEmptyString,
				text: Schema.String,
				attachments: Attachments,
				thread: Schema.optionalKey(Schema.String),
				id: Schema.optionalKey(Schema.String)
			})
		)
	);
const MailInput = Schema.Struct({
	...Common,
	to: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	subject: Schema.String,
	text: Schema.optionalKey(Schema.String),
	html: Schema.optionalKey(Schema.String),
	attachments: Attachments,
	cc: Schema.optionalKey(Schema.Array(Schema.String)),
	bcc: Schema.optionalKey(Schema.Array(Schema.String)),
	thread: Schema.optionalKey(Schema.String),
	id: Schema.optionalKey(Schema.String),
	references: Schema.optionalKey(Schema.Array(Schema.String))
}).check(
	Schema.makeFilter((value) =>
		value.text !== undefined || value.html !== undefined ? undefined : 'an email needs text or html'
	)
);
export const send_input_schema = (kind: ConversationKind): Schema.Codec<Obj> =>
	kind === 'email' ? MailInput : ChatInput;
/** A timeline entry as stored: `raw` bounded to 4 KB. */
const entry = (e: DeliveryEntry): string => {
	const raw = e.raw === undefined ? undefined : JSON.stringify(e.raw);
	return JSON.stringify(
		raw === undefined || raw.length <= 4096 ? e : { ...e, raw: raw.slice(0, 4096) }
	);
};
/** The status after kind `k` in SQL, `status_after`'s rule (status.ts): terminal wins, `auto_replied` never moves it, else the higher rank. */
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

function report_delivery(m: EngineManifest, c: Chain, changed: string, event: DeliveryEntry, extra: Obj = {}): void {
	reportRowsPiece(m, c,
		() => `SELECT r.integration::text AS instance, r.id::text AS message,
		${c.p(`report:${event.kind}:${event.at}${event.reply === undefined ? '' : `:${event.reply}`}`)} || ':' || r.id AS delivery,
		${c.p({ ...event, ...extra })}::jsonb || jsonb_build_object('message', r.id) AS body
		FROM ${changed} r WHERE r.before IS DISTINCT FROM r.status OR ${c.p(event.kind)} IN ('replied', 'auto_replied')`,
		event.at
	);
}

/** A delivery report and its sync hints share the caller's captured statement, including inbound reply admission. */
export function delivery_piece(m: EngineManifest, c: Chain, where: string, event: DeliveryEntry, extra: Obj = {}): string {
	const same = [{ kind: event.kind, at: event.at,
		...(event.code === undefined ? {} : { code: event.code }),
		...(event.reply === undefined ? {} : { reply: event.reply }) }];
	const current = c.cte('delivery_before',
		`SELECT id, status FROM sys_message WHERE ${where} AND direction = 'outbound'
		AND NOT coalesce(delivery, '[]'::jsonb) @> ${c.p(same)}::jsonb ORDER BY seq DESC LIMIT 1 FOR UPDATE`);
	const kind = c.p(event.kind);
	const changed = msg(c,
		`UPDATE sys_message s SET delivery = coalesce(s.delivery, '[]'::jsonb) || jsonb_build_array(${c.p(entry(event))}::jsonb),
		status = ${AFTER('s.status', `${kind}::text`, c.p(TERMINALS), c.p(RANKS))},
		sent_at = CASE WHEN ${kind} IN ('sent', 'delivered', 'read', 'opened', 'replied') THEN coalesce(s.sent_at, ${c.p(event.at)}::timestamptz) ELSE s.sent_at END,
		error = CASE WHEN ${kind} IN ('bounced', 'failed', 'complained', 'deferred') THEN coalesce(${c.p(event.reason ?? null)}, s.error) ELSE s.error END,
		presume_at = CASE WHEN ${kind} IN ('sent', 'deferred', 'auto_replied') THEN s.presume_at END
		FROM ${current} WHERE s.id = ${current}.id`,
		`s.id, s.integration, ${current}.status AS before, s.status`
	);
	report_delivery(m, c, changed, event, extra);
	return changed;
}
const MAX_ATTEMPTS = 8;
/** How long a row waits for a link that is down before it asks again; the link's connect (`resume`) comes first. */
const PARKED_MS = 86_400_000;
/** A sync's queued sends wait until its id map and acknowledgement commit, so their reports have a destination. */
const RELEASED = (row: string) =>
	`(${row}.meta ->> 'sync_write' IS NULL OR EXISTS (SELECT 1 FROM sys_outbox o WHERE o.key = ${row}.meta ->> 'sync_write' AND o.status = 'acked'))`;
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
	const mutateMessage = (
		statement: Sql,
		returning: string | ((before: string) => string) = '1 AS changed',
		event?: DeliveryEntry
	) => {
		const c = new Chain();
		c.params.push(...statement.params);
		const changed = msg(c, statement.text, returning);
		if (event !== undefined)
			report_delivery(m, c, changed, event);
		return nativeCommit(db.write, cfg.engine.live.publish, c,
			Schema.Struct({ ...CapturedResult.fields, messages: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
			`coalesce((SELECT jsonb_agg(to_jsonb(r) - '__bolt_capture') FROM ${changed} r), '[]'::jsonb) AS messages`
		).pipe(Effect.map((result) => result.messages));
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
		let token = yield* Schema.decodeUnknownEffect(ClaimToken)(r).pipe(
			Effect.mapError((error) => BoltError.make('internal', 'decode', error.message, error))
		);
		const owned = (statement: Sql, settled = false): Sql => {
			const c = new Chain();
			c.params.push(...statement.params);
			return { text: `${statement.text} AND ${settled ? claim_matches(c, token) : claimedBy(c, token)}`, params: c.params };
		};
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
				BoltError.make('bad_answer', 'deliver', 'the outbound row has no message')
			)
		);
		const [refs] = yield* db.read([
			sql(
				`SELECT provider_id FROM sys_message WHERE conversation = $1 AND provider_id IS NOT NULL AND id <> $2
				AND (direction = 'inbound' OR status IN ('sent', 'deferred', 'delivered', 'read', 'opened', 'replied'))
				AND deleted_at IS NULL ORDER BY seq DESC LIMIT 50`,
				r['conversation'] ?? null,
				r['id'] ?? null
			)
		]);
		const references = (refs?.rows ?? []).map((x) => String(x['provider_id'])).reverse();
		const thread = String(r['conv_thread']),
			to = email ? {} : { to: thread },
			idempotent = inst['idempotent'] === true;
		const reply_to = body['reply_to'] ?? (email ? references.at(-1) : undefined);
		const wire: Obj = {
			...body,
			id: String(r['id']),
			...to,
			...(reply_to === undefined ? {} : { reply_to }),
			...(email && references.length > 0 ? { references } : {})
		};
		// a lease that ran out left no answer, so this row's send may have gone, as one that timed out may have
		let handed = r['was'] === 'sending';
		const got =
			handed && !idempotent
				? Result.fail(
						new FacilityFailure({ kind: 'timeout', message: 'the send ended without an answer' })
					)
				: yield* Effect.gen(function* () {
						const attachments = body['attachments'];
						const attachmentRefs = EffectArray.isArray<typeof attachments>(attachments)
							? attachments
							: [];
						const files = yield* attachmentsOf(attachmentRefs);
						const c = new Chain();
						const [renewed] = yield* db.returning(ClaimToken, {
							text: renewClaims('outbound', c, [token], iso(yield* Clock.currentTimeMillis)),
							params: c.params
						});
						if (renewed === undefined) return null;
						token = renewed;
						handed = true;
						return yield* cfg.send(instance, wire, files);
					}).pipe(Port.call('link', LIMITS.callMs.http), Effect.result);
		const attempts = token.attempts;
		if (got._tag === 'Success') {
			const receipt = got.success;
			if (receipt === null) return 'lost';
			const presume =
				'presume_after_ms' in receipt &&
				typeof receipt.presume_after_ms === 'number' &&
				receipt.presume_after_ms > 0
					? new Date(Date.parse(now) + receipt.presume_after_ms).toISOString()
					: null;
			const changed = yield* mutateMessage(
				owned(sql(
					`UPDATE sys_message SET status = ${AFTER('status', "'sent'", '$6', '$7')}, provider_id = $2, sent_at = $3::timestamptz,
				error = CASE WHEN status IN ('sending', 'sent') THEN NULL ELSE error END,
				presume_at = CASE WHEN status IN ('sending', 'sent', 'deferred') THEN coalesce(presume_at, $4::timestamptz) END,
				delivery = coalesce(delivery, '[]'::jsonb) || jsonb_build_array($5::jsonb)
				WHERE id = $1 AND (provider_id IS NULL OR provider_id = $2)`,
					r['id'] ?? null,
					receipt.provider_id,
					now,
					presume,
					entry({ kind: 'sent', at: now, provider: 'bolt' }),
					TERMINALS,
					RANKS
				), true),
				'id, integration, NULL::text AS before, status',
				{ kind: 'sent', at: now, provider: 'bolt' }
			);
			if (changed.length === 0) return 'lost';
			yield* cfg.announce(now);
			return 'sent';
		}
		const cause = got.failure,
			refusal = sendRefusal(cause);
		// A known unavailable connection is no provider handoff: keep the row until pairing/reconnection.
		if (cause instanceof Unavailable && cause.facility === LINK_DOWN) {
			yield* mutateMessage(
				owned(sql(
					`UPDATE sys_message SET status = 'queued', attempts = attempts - 1, claimed_at = NULL,
					error = coalesce(error, $3), next_attempt_at = $2::timestamptz WHERE id = $1`,
					r['id'] ?? null,
					iso(Date.parse(now) + PARKED_MS),
					cause.reason
				)),
				'id, integration, NULL::text AS before, status'
			);
			return 'retry';
		}
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
		// A lost or malformed answer after handoff may have sent; only an explicit refusal proves otherwise.
		const unsure = handed && refusal === null && !(cause instanceof Unavailable) && kind !== 'invalid';
		const final =
			fenced ||
			refusal?.permanent === true ||
			kind === 'invalid' ||
			kind === 'unavailable' ||
			(unsure && !idempotent) ||
			attempts >= MAX_ATTEMPTS;
		const status = !final ? 'queued' : unsure ? 'uncertain' : 'failed';
		// a retry is `deferred` on the timeline while the queue keeps the row `queued`; `uncertain` may have sent, so it records nothing
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
		const changed = yield* mutateMessage(
			owned(sql(
				`UPDATE sys_message SET status = $2, error = $3, next_attempt_at = $4::timestamptz, delivery = delivery || coalesce($5::jsonb, '[]'::jsonb) WHERE id = $1`,
				r['id'] ?? null,
				status,
				error.slice(0, 2000),
				iso(Date.parse(now) + retryDelay(attempts, 1_000, 300_000)),
				e === null ? null : `[${entry(e)}]`
			)),
			'id, integration, NULL::text AS before, status',
			// The first retry and a final failure reach the sync's next read, atomically with the message status.
			e !== null && (status === 'failed' || attempts === 1) ? e : undefined
		);
		if (changed.length === 0) return 'lost';
		if (e !== null && (status === 'failed' || attempts === 1)) yield* cfg.announce(now);
		return status === 'queued' ? 'retry' : status;
	});
	const deliver = Effect.fn('Outbound.deliver')(function* () {
		let sent = 0,
			failed = 0,
			exhausted = true;
		const cleanup = new Chain();
		msg(
			cleanup,
			`UPDATE sys_message SET status = 'skipped', error = 'queued in another environment epoch'
            WHERE direction = 'outbound' AND status IN ('queued', 'sending') AND coalesce(epoch, '') <> ${cleanup.p(epoch)}`,
			'1 AS changed'
		);
		msg(
			cleanup,
			`UPDATE sys_message SET status = 'failed', error = 'a personal account never sends'
            WHERE direction = 'outbound' AND status IN ('queued', 'sending') AND integration IN (SELECT id FROM sys_integration WHERE owner IS NOT NULL)`,
			'1 AS changed'
		);
		msg(
			cleanup,
			`UPDATE sys_message s SET status = 'skipped', error = 'the sync write was refused'
			WHERE s.direction = 'outbound' AND s.status = 'queued' AND EXISTS
			(SELECT 1 FROM sys_outbox o WHERE o.key = s.meta ->> 'sync_write' AND o.status IN ('failed', 'skipped'))`,
			'1 AS changed'
		);
		yield* nativeCommit(db.write, cfg.engine.live.publish, cleanup, CapturedResult);
		for (let round = 0; round < 1000; round++) {
			const now = iso(yield* Clock.currentTimeMillis);
			// Unpaired rows keep their queued state and budget; prior sends still need uncertainty recovery.
			const claimed = yield* mutateMessage(
				{
					text: claimSql('outbound', {
						at: '$1',
						where: `q.direction = 'outbound' AND q.integration IS NOT NULL AND q.message IS NOT NULL AND q.conversation IS NOT NULL
							AND EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = q.integration AND i.active
								AND (q.status = 'sending' OR i.status ->> 'state' = 'connected'))
							AND ${RELEASED('q')}
							AND NOT EXISTS (SELECT 1 FROM sys_message p WHERE p.integration = q.integration AND p.direction = 'outbound' AND p.status IN ('queued', 'sending') AND p.seq < q.seq AND p.conversation = q.conversation)`,
						order: 'q.seq',
						limit: 1000
					}),
					params: [now]
				},
				(before) => `q.id, q.integration, q.conversation, q.message, q.attempts, q.claimed_at::text AS claimed_at, ${before}.status AS was,
					(SELECT thread FROM sys_conversation c WHERE c.id = q.conversation) AS conv_thread,
					(SELECT jsonb_build_object('integration', i.integration, 'configuration', i.configuration, 'idempotent', i.status -> 'idempotent_sends') FROM sys_integration i WHERE i.id = q.integration) AS inst`
			);
			if (claimed.length === 0) {
				exhausted = false;
				break;
			}
			for (const r of claimed) {
				const x = yield* message(r);
				if (x === 'sent') sent++;
				else if (x !== 'retry' && x !== 'lost') failed++;
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
		// a due row left here waits behind an earlier one, and that one's retry or lease decides; a run lost with its fiber
		// comes back at boot and reaches this, so a send that never answered gets its wake without one queued before each send
		const [next] = yield* db.read([
			sql(
				`SELECT least(min(next_attempt_at) FILTER (WHERE status = 'queued' AND next_attempt_at > $1::timestamptz), min(${leaseExpiry('outbound', '')}) FILTER (WHERE status = 'sending'),
				min(presume_at) FILTER (WHERE status IN ('sent', 'deferred')))::text AS due
			FROM sys_message s WHERE direction = 'outbound' AND (status IN ('queued', 'sending') OR presume_at IS NOT NULL) AND ${RELEASED('s')}`,
				now
			)
		]);
		const due = exhausted ? now : next?.rows[0]?.['due'];
		if (
			typeof due === 'string' &&
			(exhausted || Date.parse(due) > Date.parse(iso(yield* Clock.currentTimeMillis)))
		) {
			const at = new Date(due).toISOString();
			const c = new Chain();
			enqueueDrain(c, DELIVER, c.p(at));
			yield* nativeCommit(db.write, cfg.engine.live.publish, c, CapturedResult);
			yield* cfg.announce(at);
		}
		return { sent, failed };
	});
	const record = Effect.fn('Outbound.record')(function* (
		where: string,
		params: readonly Json[],
		e: DeliveryEntry
	) {
		const c = new Chain();
		c.params.push(...params);
		const changed = delivery_piece(m, c, where, e);
		const result = yield* nativeCommit(db.write, cfg.engine.live.publish, c,
			Schema.Struct({ ...CapturedResult.fields, n: Schema.Number }),
			`(SELECT count(*) FROM ${changed})::int AS n`
		);
		if (result.n > 0) yield* cfg.announce(e.at);
	});

	return {
		deliver,
		reference: Effect.fn('Outbound.reference')(function* (instance: string, input: OutboundReference) {
			const reference = yield* Schema.decodeUnknownEffect(OutboundReference, { onExcessProperty: 'error' })(input).pipe(
				Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
			);
			const changed = yield* mutateMessage(sql(
				`UPDATE sys_message SET provider_id = $3 WHERE id = $2 AND integration = $1
				AND direction = 'outbound' AND status = 'sending' AND deleted_at IS NULL
				AND coalesce(epoch, '') = ${EPOCH}
				AND (provider_id IS NULL OR provider_id = $3)
				AND EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = $1 AND i.owner IS NULL AND i.active)`,
				instance, reference.message, reference.provider_id
			));
			if (changed.length === 0)
				return yield* Effect.fail(BoltError.make('conflict', 'commit', 'The outbound reference does not match an active send.'));
		}),
		resume: Effect.fn('Outbound.resume')(function* (instance: string) {
			const now = iso(yield* Clock.currentTimeMillis),
				c = new Chain();
			const due = msg(
				c,
				`UPDATE sys_message SET next_attempt_at = ${c.p(now)}::timestamptz WHERE integration = ${c.p(instance)}
				AND direction = 'outbound' AND status = 'queued'`,
				'id'
			);
			deliverRun(c, due, now);
			const row = yield* nativeCommit(db.write, cfg.engine.live.publish, c,
				Schema.Struct({ ...CapturedResult.fields, n: Schema.Number }),
				`(SELECT count(*) FROM ${due})::int AS n`
			);
			if (row.n > 0) yield* cfg.announce(now);
		}),
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
			provider_id: string,
			report: DeliveryReport
		): Effect.Effect<void, EngineError> =>
			record(
				'integration = $1 AND provider_id = $2',
				[instance, provider_id],
				report.reason === undefined && (report.kind === 'bounced' || report.kind === 'failed')
					? { ...report, reason: report.code ?? report.kind }
					: report
			),
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
