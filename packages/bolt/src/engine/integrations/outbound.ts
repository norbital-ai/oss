// Outbound (§4.2): a record-bound send — a conversation definition's message, or any other definition's command (its
// `run`). The commit that makes a row of `from` effective (created or updated as `on` says, matching `when`, once any
// approval has passed: a held write commits nothing) queues one `sys_message` outbound row in its own statement, keyed
// once per rule, record, instance and version — no fan-out. The `integrations.deliver` run builds each row's payload from
// the committed record at every attempt and records its hash before any I/O; a key whose payload changed since is refused
// (`submissionChanged`), never sent; a sent row is never sent again; a record it cannot read or build for now is retried. Delivery is serial per instance and
// conversation (a command: per instance and record), leased, and skips rows of another environment epoch. A message goes
// through the instance's link: 8 attempts, `uncertain` on a final timeout, its delivery reports and replies on the
// timeline and, through the rule's `events`, patching only the record. A command runs until acknowledged: transient
// failures back off (capped), never terminal; `ctx.key` is the remote's idempotency key. Reads of `from` carry
// `$outbound` (each rule's latest row); receipts never touch the record's history.
import { Clock, Crypto, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Drivers, Files } from '../ports.ts';
import {
	Activation,
	Guest,
	Identity,
	Links,
	Live,
	Manifest,
	Outbound,
	Reads,
	RunHandlers,
	Wake,
	Writes,
	type GuestShape,
	type OutboundFile,
	type RunHandler
} from '../services.ts';
import { Port } from '../port.ts';
import { iso, backoffMs } from '../runs/time.ts';
import { enqueue } from '../runs/queue.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Pred } from '../../protocol/ir-types.ts';
import type { Bindings, Sql } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { Unavailable } from '../../decl/errors.ts';
import { collectionOf, defaultFields, q } from '../../protocol/catalog.ts';
import * as ir from '../../protocol/ir.ts';
import { catalogOf, toPred } from '../access/pred.ts';
import { LIMITS, type EngineActor, type Outcome } from '../contracts.ts';
import { Fenced, isTransient, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { canonical, Chain, GATED, ownPredSql, sha256Hex } from '../write/sql.ts';
import { conversationId, preview, threadOf, msg } from '../conversations/store.ts';
import {
	RANK,
	SendRefused,
	sendRefusal,
	TERMINAL,
	type DeliveryEntry,
	type DeliveryKind,
	type DeliveryReport
} from '../conversations/status.ts';
import { conversational, conversationOf, definitionOf, integrationBody } from './instances.ts';
import type { OutboundState } from '../../decl/names.ts';
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
/**
 * One outbound rule (`<def>.<rule>`), with the instance it goes through: a connection slot, or an FK of `from`. A
 * conversation definition's rule sends a message of its `kind`; any other's is a command (`kind` null).
 */
type Rule = {
	name: string;
	definition: string;
	rule: string;
	from: string;
	on: readonly string[];
	when: Pred | undefined;
	via:
		| {
				slot: string;
		  }
		| {
				fk: string;
		  };
	version: string | undefined;
	class: 'message' | 'command';
	kind: ConversationKind | null;
};
const memo = new WeakMap<EngineManifest, readonly Rule[]>();
function rulesOf(m: EngineManifest): readonly Rule[] {
	let rules = memo.get(m);
	if (rules === undefined)
		memo.set(
			m,
			(rules = Object.entries(m.integrations).flatMap(([definition, def]) =>
				Object.entries(def.outbound ?? {}).map(([rule, o]): Rule => ({
					name: `${definition}.${rule}`,
					definition,
					rule,
					from: o.from,
					on: o.on === undefined ? ['create'] : typeof o.on === 'string' ? [o.on] : [...o.on],
					when: o.when === undefined ? undefined : toPred(m, o.from, o.when),
					via: m.connections[o.via]?.integration === definition ? { slot: o.via } : { fk: o.via },
					version: o.version,
					class: conversational(def) ? 'message' : 'command',
					kind: conversationOf(def)?.kind ?? null
				}))
			))
		);
	return rules;
}
const froms = new WeakMap<EngineManifest, ReadonlySet<string>>();
/** The collections an outbound rule sends from: their reads carry `$outbound`. */
export const outboundFrom = (m: EngineManifest): ReadonlySet<string> => {
	let from = froms.get(m);
	if (from === undefined) froms.set(m, (from = new Set(rulesOf(m).map((r) => r.from))));
	return from;
};
/**
 * hook:integrations (write/commit.ts) — the act statement's outbound piece, over the statement's own direct writes (`allp`)
 * of `written` tables: one queued row per matching rule, through an instance of its definition (never a personal one),
 * keyed so a record and version send once. An instance taken off pause wakes the delivery of what waited for it.
 */
export function outboundPiece(
	m: EngineManifest,
	c: Chain,
	now: string,
	written: ReadonlySet<string>,
	source = 'allp'
): void {
	const rules = rulesOf(m).filter((r) => written.has(r.from));
	const resumed = written.has('sys_integration')
		? [
				`SELECT 1 FROM ${source} x WHERE x.c = 'sys_integration' AND x.op = 'update' AND (x.n ->> 'active')::boolean
		AND (x.o ->> 'active')::boolean IS NOT TRUE`
			]
		: [];
	let queued: string | undefined;
	if (rules.length > 0)
		queued = msg(
			c,
			`INSERT INTO sys_message (id, integration, direction, status, record, rule, key, class, epoch, next_attempt_at, created_at, delivery)
		SELECT gen_random_uuid()::text, o.instance, 'outbound', 'queued', jsonb_build_object('collection', o.c, 'id', o.id), o.rule,
			encode(sha256(convert_to(json_build_array(o.rule, o.id, o.instance, o.version)::text, 'UTF8')), 'hex'), o.class, ${EPOCH},
			${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${QUEUED(c, now)}
		FROM (${rules
			.map((r) => {
				const image = `jsonb_populate_record(null::${q(r.from)}, x.n)`;
				return `SELECT ${c.p(r.name)}::text AS rule, ${c.p(r.definition)}::text AS def, ${c.p(r.class)}::text AS class, x.c, x.id,
			${'slot' in r.via ? `${c.p(r.via.slot)}::text` : `x.n ->> ${c.p(r.via.fk)}`} AS instance, ${r.version === undefined ? 'x.id' : `x.n ->> ${c.p(r.version)}`} AS version
		FROM ${source} x WHERE x.c = ${c.p(r.from)} AND x.cause = 'direct' AND x.op IN (SELECT jsonb_array_elements_text(${c.p(r.on)}::jsonb))
			AND ${r.when === undefined ? 'true' : ownPredSql(r.when, image, c)}`;
			})
			.join(
				' UNION ALL '
			)}) o JOIN sys_integration i ON i.id = o.instance AND i.integration = o.def AND i.owner IS NULL
		WHERE o.version IS NOT NULL AND ${GATED} ON CONFLICT (key) DO NOTHING`,
			'id'
		);
	const due = [...resumed, ...(queued === undefined ? [] : [`SELECT 1 FROM ${queued}`])];
	if (due.length === 0) return;
	c.cte('outbound_due', due.join(' UNION ALL '));
	deliverRun(c, 'outbound_due', now);
}
/** What `$outbound` says of a rule's latest row: a delivered, read or replied message is `sent`, a bounced one `failed`. */
const stateOf = (status: string): OutboundState['status'] =>
	status === 'queued' ||
	status === 'sending' ||
	status === 'skipped' ||
	status === 'failed' ||
	status === 'uncertain'
		? status
		: status === 'bounced' || status === 'complained'
			? 'failed'
			: 'sent';
/** `$outbound` of the rows `ids` of `collection`, by record and rule; `undefined` when no rule sends from it. */
export const outboundState = Effect.fn('Outbound.outboundState')(function* (
	m: EngineManifest,
	db: Pick<TenantDbShape, 'read'>,
	collection: string,
	ids: readonly string[]
) {
	const rules = rulesOf(m)
		.filter((r) => r.from === collection)
		.map((r) => r.name);
	if (rules.length === 0) return undefined;
	const out = new Map<
		string,
		{
			[rule: string]: OutboundState;
		}
	>(ids.map((id) => [id, {}]));
	if (ids.length === 0) return out;
	// ponytail: matched on `record ->> 'id'` with no index of its own; an expression index when outbound volume shows it
	const [res] = yield* db.read([
		{
			text: `SELECT DISTINCT ON (rule, record ->> 'id') rule, record ->> 'id' AS id, status, error FROM sys_message
		WHERE direction = 'outbound' AND rule IN (SELECT jsonb_array_elements_text($1::jsonb)) AND record ->> 'collection' = $2
			AND record ->> 'id' IN (SELECT jsonb_array_elements_text($3::jsonb)) ORDER BY rule, record ->> 'id', seq DESC`,
			params: [JSON.stringify(rules), collection, JSON.stringify(ids)]
		}
	]);
	for (const r of res?.rows ?? []) {
		const state = out.get(String(r['id']));
		if (state !== undefined)
			state[String(r['rule'])] = {
				status: stateOf(String(r['status'])),
				error: typeof r['error'] === 'string' ? r['error'] : null
			};
	}
	return out;
});
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
/** A command retries these (rule 54's transient codes, an absent link, an interrupted generation) until it is acknowledged. */
const retryable = (error: EngineError): boolean =>
	isTransient(error) ||
	error._tag === 'Interrupted' ||
	(error._tag === 'BoltError' && (error.code === 'unavailable' || error.code === 'interrupted'));
const sql = (text: string, ...params: Json[]) => ({ text, params });
type OutboundConfig = {
	crypto: Crypto.Crypto;
	engine: {
		manifest: EngineManifest;
		db: TenantDbShape;
		act: Writes['Service']['act'];
		read: Reads['Service']['run'];
		authority: Identity['Service']['authority'];
		live: Live['Service'];
		bindings: () => Effect.Effect<Bindings>;
	};
	guest: GuestShape;
	links: Drivers['Service'];
	send: Links['Service']['send'];
	files: Files['Service'];
	announce: (at: string) => Effect.Effect<void>;
	epoch: string;
};
function makeOutbound(cfg: OutboundConfig) {
	const { manifest: m, db } = cfg.engine;
	const cat = catalogOf(m),
		epoch = cfg.epoch;
	const bodies = {
		manifest: m,
		db,
		read: cfg.engine.read,
		bindings: cfg.engine.bindings,
		guest: cfg.guest,
		links: cfg.links
	};
	const ruleOf = (name: Json | undefined): Rule | undefined =>
		typeof name === 'string' ? rulesOf(m).find((r) => r.name === name) : undefined;
	const actorOf = (rule: Rule, instance: string, run: string): EngineActor => ({
		kind: 'system',
		run,
		by: { integration: rule.definition, instance, outbound: rule.rule }
	});
	const backoff = (now: string, attempts: number) =>
		new Date(Date.parse(now) + Math.min(backoffMs('1s', attempts), 300000)).toISOString();
	/** A rule row's record changed state: its `$outbound` views read again. */
	const touched = (r: Obj) => {
		const rec = r['record'];
		if (
			r['rule'] !== null &&
			Predicate.isObject(rec) &&
			typeof rec['collection'] === 'string' &&
			typeof rec['id'] === 'string'
		)
			cfg.engine.live.syncChanged(rec['collection'], [rec['id']]);
	};
	const built = Effect.fn('Outbound.built')(function* (
		r: Obj
	): Effect.fn.Return<
		| { settle: 'skipped' | 'failed'; error: string }
		| { retry: string }
		| { payload: Obj; hash: string },
		EngineError
	> {
		const rule = ruleOf(r['rule']),
			rec = r['record'];
		if (rule === undefined || !Predicate.isObject(rec))
			return {
				settle: 'skipped' as const,
				error: `the rule ${String(r['rule'])} is no longer declared`
			};
		const collection = String(rec['collection']),
			select = Object.fromEntries(
				defaultFields(collectionOf(cat, collection), true).map((field) => [field, true])
			);
		const bindings = yield* cfg.engine.bindings();
		const read = yield* cfg.engine
			.read([ir.get(cat, collection, String(rec['id']), { select })], { as: 'workspace' }, bindings)
			.pipe(Effect.result);
		if (read._tag === 'Failure')
			return { retry: `the record could not be read: ${read.failure.message}` };
		const row = read.success[0];
		if (row === null || row === undefined)
			return { settle: 'skipped' as const, error: 'the record no longer exists' };
		const result = yield* integrationBody(bodies, {
			id: `${String(r['id'])}:build:${String(r['attempts'])}`,
			actor: actorOf(rule, String(r['integration']), String(r['id'])),
			path: `integration_definition.${rule.definition}.bodies.outbound.${rule.rule}.build`,
			args: [row]
		}).pipe(Effect.result);
		if (result._tag === 'Failure') {
			const error = `the ${rule.name} build failed: ${result.failure.message}`;
			return retryable(result.failure) ? { retry: error } : { settle: 'failed' as const, error };
		}
		if (result.success === null)
			return {
				settle: 'skipped' as const,
				error: `the ${rule.name} build sends nothing for this record`
			};
		let payload: Obj;
		if (rule.kind !== null) {
			const checked = yield* Schema.decodeUnknownEffect(sendInputSchema(rule.kind))(
				result.success,
				{ errors: 'all', onExcessProperty: 'error' }
			).pipe(Effect.result);
			if (checked._tag === 'Failure')
				return {
					settle: 'failed' as const,
					error: `the message does not fit ${rule.definition}: ${checked.failure.message}`
				};
			payload = checked.success;
		} else {
			if (!Predicate.isObject(result.success))
				return { settle: 'failed' as const, error: `the ${rule.name} payload is not an object` };
			payload = result.success;
			if (new TextEncoder().encode(canonical(payload)).byteLength > LIMITS.argsBytes)
				return {
					settle: 'failed' as const,
					error: `the ${rule.name} payload is over ${LIMITS.argsBytes} bytes`
				};
		}
		return { payload, hash: sha256Hex(canonical(payload)) };
	});
	const mutateMessage = (statement: Sql, returning = '1 AS changed') => {
		const c = new Chain();
		c.params.push(...statement.params);
		const changed = msg(c, statement.text, returning);
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
	const settle = Effect.fn('Outbound.settle')(function* (
		r: Obj,
		status: 'failed' | 'skipped',
		error: string
	) {
		const e: DeliveryEntry = {
			kind: 'failed',
			at: iso(yield* Clock.currentTimeMillis),
			provider: 'bolt',
			reason: error.slice(0, 500),
			permanent: true
		};
		yield* mutateMessage(
			sql(
				`UPDATE sys_message SET status = $2, error = $3, delivery = delivery || CASE WHEN $2 = 'failed' THEN jsonb_build_array($4::jsonb) ELSE '[]'::jsonb END
			WHERE id = $1 AND status IN ('queued', 'sending')`,
				r['id'] ?? null,
				status,
				error.slice(0, 2000),
				entry(e)
			)
		);
		if (status === 'failed' && r['class'] !== 'command')
			yield* patch(r, 'failed', { ...e, message: r['id'] ?? null });
		touched(r);
	});
	const later = Effect.fn('Outbound.later')(function* (r: Obj, error: string, attempts: number) {
		if (r['class'] !== 'command' && attempts >= MAX_ATTEMPTS) {
			yield* settle(r, 'failed', error);
			return 'failed';
		}
		yield* mutateMessage(
			sql(
				`UPDATE sys_message SET status = 'queued', attempts = $4, error = $2, next_attempt_at = $3::timestamptz WHERE id = $1`,
				r['id'] ?? null,
				error.slice(0, 2000),
				backoff(iso(yield* Clock.currentTimeMillis), attempts),
				attempts
			)
		);
		touched(r);
		return 'retry';
	});
	const build = Effect.fn('Outbound.build')(function* (r: Obj) {
		const b = yield* built(r);
		if ('retry' in b) {
			yield* later(r, b.retry, Number(r['attempts']) + 1);
			return;
		}
		if ('settle' in b) return yield* settle(r, b.settle, b.error);
		const rule = ruleOf(r['rule']),
			instance = String(r['integration']);
		if (rule === undefined || rule.kind === null) return;
		const thread = yield* threadOf(
			instance,
			rule.kind,
			b.payload,
			cfg.crypto,
			Predicate.isObject(r['record']) ? String(r['record']['id']) : undefined
		).pipe(Effect.provideService(TenantDb, db));
		const conv = conversationId(instance, thread);
		const text =
			typeof b.payload['text'] === 'string'
				? b.payload['text']
				: String(b.payload['subject'] ?? '');
		const c = new Chain();
		c.cte(
			'conv',
			`INSERT INTO sys_conversation (id, integration, thread, kind) VALUES (${c.p(conv)}, ${c.p(instance)}, ${c.p(thread)}, 'dm') ON CONFLICT (id) DO NOTHING RETURNING id`
		);
		msg(
			c,
			`UPDATE sys_message SET message = ${c.p(b.payload)}::jsonb, hash = ${c.p(b.hash)}, conversation = ${c.p(conv)}, thread = ${c.p(typeof b.payload['thread'] === 'string' ? b.payload['thread'] : null)}, text = ${c.p(text)}, preview = ${c.p(preview(text))}
            WHERE id = ${c.p(r['id'] ?? null)} AND status = 'queued' AND message IS NULL`,
			'1 AS changed'
		);
		yield* db.write(c.sql('NULL AS outcome'));
	});
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
	const command = Effect.fn('Outbound.command')(function* (r: Obj) {
		const rule = ruleOf(r['rule']),
			now = iso(yield* Clock.currentTimeMillis),
			attempts = Number(r['attempts']);
		if (rule === undefined) {
			yield* settle(r, 'skipped', `the rule ${String(r['rule'])} is no longer declared`);
			return 'failed' as const;
		}
		const result = yield* integrationBody(bodies, {
			id: `${String(r['id'])}:run:${attempts}`,
			actor: actorOf(rule, String(r['integration']), String(r['id'])),
			path: `integration_definition.${rule.definition}.bodies.outbound.${rule.rule}.run`,
			args: [r['message'] ?? null, { $ctx: true }],
			instance: String(r['integration']),
			key: String(r['key']),
			configuration: Predicate.isObject(r['inst']) ? (r['inst']['configuration'] ?? {}) : {},
			request: true
		}).pipe(
			Effect.flatMap((out) =>
				Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.NonEmptyString }))(out).pipe(
					Effect.mapError(() =>
						BoltError.make('badAnswer', 'guest', `${rule.name}: run answered no { id }`)
					)
				)
			),
			Effect.result
		);
		if (result._tag === 'Failure') {
			if (!retryable(result.failure)) {
				yield* settle(r, 'failed', result.failure.message);
				return 'failed' as const;
			}
			return yield* later(r, result.failure.message, attempts);
		}
		yield* mutateMessage(
			sql(
				`UPDATE sys_message SET status = 'sent', provider_id = $2, sent_at = $3::timestamptz, error = NULL, delivery = delivery || jsonb_build_array($4::jsonb) WHERE id = $1`,
				r['id'] ?? null,
				result.success.id,
				now,
				entry({ kind: 'sent', at: now, provider: 'bolt' })
			)
		);
		touched(r);
		return 'sent' as const;
	});
	const sent = Effect.fn('Outbound.sent')(function* (r: Obj, definition: string, message: Obj) {
		const instance = String(r['integration']),
			id = String(r['id']);
		return yield* integrationBody(bodies, {
			id: `${id}:send:${String(r['attempts'])}`,
			actor: { kind: 'system', run: id, by: { platform: `${definition}.send` } },
			path: `integration_definition.${definition}.bodies.send`,
			args: [message, { $ctx: true }],
			instance,
			key: String(r['key'] ?? id),
			configuration: Predicate.isObject(r['inst']) ? (r['inst']['configuration'] ?? {}) : {},
			request: true
		}).pipe(
			Effect.flatMap((out) =>
				Schema.decodeUnknownEffect(Schema.Struct({ providerId: Schema.NonEmptyString }))(
					Predicate.isObject(out) ? { providerId: out['id'] } : out
				).pipe(
					Effect.mapError(() =>
						BoltError.make('badAnswer', 'guest', `${definition}: send answered no { id }`)
					)
				)
			)
		);
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
		const got = yield* (
			def?.conversation !== undefined
				? sent(r, name, { ...body, ...to, thread })
				: Effect.gen(function* () {
						const refs = Array.isArray(body['attachments']) ? body['attachments'] : [];
						const files = yield* attachmentsOf(refs);
						return yield* cfg.send(instance, wire, files);
					})
		).pipe(Port.call('link', LIMITS.callMs.http), Effect.result);
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
				)
			);
			yield* patch(r, 'sent', {
				kind: 'sent',
				at: now,
				provider: 'bolt',
				message: r['id'] ?? null
			});
			touched(r);
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
			)
		);
		// the first retry and a final failure reach the row's `events` (a retry each time would re-patch the same state)
		if (e !== null && (status === 'failed' || attempts === 1))
			yield* patch(r, e.kind, { ...e, message: r['id'] ?? null });
		touched(r);
		return status === 'queued' ? 'retry' : status;
	});
	const attempt = Effect.fn('Outbound.attempt')(function* (r: Obj) {
		let row = r;
		if (r['rule'] !== null) {
			const again = yield* built(r);
			if ('retry' in again) return yield* later(r, again.retry, Number(r['attempts']));
			if ('settle' in again) {
				yield* settle(r, again.settle, again.error);
				return 'failed';
			}
			if (r['hash'] === null)
				yield* mutateMessage(
					sql(
						`UPDATE sys_message SET message = $2::jsonb, hash = $3 WHERE id = $1`,
						r['id'] ?? null,
						JSON.stringify(again.payload),
						again.hash
					)
				);
			else if (again.hash !== r['hash']) {
				yield* settle(
					r,
					'failed',
					`submissionChanged: the ${String(r['rule'])} payload changed under the same key; declare a new version to send it`
				);
				return 'failed';
			}
			// every attempt hands the payload as built, never its stored jsonb (which reorders keys): a retry sees what the first saw
			row = { ...r, message: again.payload, hash: again.hash };
		}
		return yield* row['class'] === 'command' ? command(row) : message(row);
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
		yield* db.write(
			cleanup.sql(`(SELECT count(*) FROM ${skipped}) + (SELECT count(*) FROM ${personal}) AS n`)
		);
		const [unbuilt] = yield* db.read([
			sql(
				`SELECT s.id, s.integration, s.record, s.rule, s.class, s.attempts FROM sys_message s JOIN sys_integration i ON i.id = s.integration AND i.active
			WHERE s.direction = 'outbound' AND s.status = 'queued' AND s.message IS NULL AND s.rule IS NOT NULL AND s.class = 'message' AND s.next_attempt_at <= $1::timestamptz
			ORDER BY s.seq LIMIT 1000`,
				iso(yield* Clock.currentTimeMillis)
			)
		]);
		for (const r of unbuilt?.rows ?? []) yield* build(r);
		for (let round = 0; round < 1000; round++) {
			const now = iso(yield* Clock.currentTimeMillis);
			const claimed = yield* mutateMessage(
				sql(
					`UPDATE sys_message s SET status = 'sending', attempts = s.attempts + 1, claimed_at = $1::timestamptz
				WHERE s.direction = 'outbound' AND s.integration IS NOT NULL AND (s.class = 'command' OR (s.message IS NOT NULL AND s.conversation IS NOT NULL))
					AND ((s.status = 'queued' AND s.next_attempt_at <= $1::timestamptz) OR (s.status = 'sending' AND s.claimed_at < $1::timestamptz - ${LEASE}))
					AND EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = s.integration AND i.active)
					AND NOT EXISTS (SELECT 1 FROM sys_message p WHERE p.integration = s.integration AND p.direction = 'outbound' AND p.status IN ('queued', 'sending') AND p.seq < s.seq
						AND CASE WHEN s.conversation IS NULL THEN p.conversation IS NULL AND p.record = s.record ELSE p.conversation = s.conversation END)`,
					now
				),
				`s.id, s.integration, s.conversation, s.message, s.record, s.rule, s.key, s.hash, s.class, s.attempts,
					(SELECT thread FROM sys_conversation c WHERE c.id = s.conversation) AS conv_thread,
					(SELECT jsonb_build_object('integration', i.integration, 'configuration', i.configuration) FROM sys_integration i WHERE i.id = s.integration) AS inst`
			);
			if (claimed.length === 0) break;
			for (const r of claimed) {
				const x = yield* attempt(r);
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
			FROM sys_message WHERE direction = 'outbound' AND (status = 'queued' OR presume_at IS NOT NULL)`)
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
			's.id, s.record, s.rule, s.integration, s.class, cur.status AS before, s.status'
		);
		const row = res[0];
		if (
			row === undefined ||
			(row['before'] === row['status'] && e.kind !== 'replied' && e.kind !== 'auto_replied')
		)
			return null;
		touched(row);
		const { reply: _, ...fields } = e;
		return yield* patch(row, e.kind, { ...fields, message: row['id'] ?? null, ...extra });
	});
	const patch = Effect.fn('Outbound.patch')(function* (row: Obj, kind: DeliveryKind, event: Obj) {
		const rule = ruleOf(row['rule']),
			rec = row['record'];
		if (
			rule === undefined ||
			!Predicate.isObject(rec) ||
			typeof rec['collection'] !== 'string' ||
			typeof rec['id'] !== 'string'
		)
			return null;
		const actor = actorOf(rule, String(row['integration']), `outbound:${String(event['message'])}`);
		const result = yield* integrationBody(bodies, {
			id: `${String(event['message'])}:${kind}`,
			actor,
			path: `integration_definition.${rule.definition}.bodies.outbound.${rule.rule}.events.${kind}`,
			args: [event]
		}).pipe(Effect.result);
		if (result._tag === 'Failure')
			return result.failure._tag === 'BoltError' && result.failure.code === 'missingBody'
				? null
				: {
						kind: 'refused' as const,
						code: 'invalidInput' as const,
						message: `the ${kind} event of ${rule.name} failed: ${result.failure.message}`
					};
		if (!Predicate.isObject(result.success) || Object.keys(result.success).length === 0)
			return null;
		const set = result.success,
			collection = rec['collection'],
			id = rec['id'];
		const authority = yield* cfg.engine.authority(
			{ actor, policies: [], admin: true },
			`outbound:${rule.name}`
		);
		let attempt = 0;
		return yield* Effect.gen(function* () {
			const bindings = yield* cfg.engine.bindings(),
				key = `outbound:${rule.name}:${String(event['message'])}:${kind}:${attempt++}`;
			return (yield* cfg.engine.act({
				collection,
				verb: 'update',
				input: { target: id, set },
				key,
				issuedAt: bindings.now,
				authority,
				bindings,
				invocationId: key,
				mode: { _tag: 'Direct', delivery: true }
			})).outcome;
		}).pipe(Effect.repeat({ until: (outcome) => outcome.kind !== 'conflict', times: 4 }));
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
			writes = yield* Writes,
			reads = yield* Reads,
			identity = yield* Identity,
			live = yield* Live,
			guest = yield* Guest,
			drivers = yield* Drivers,
			files = yield* Files,
			wake = yield* Wake,
			activation = yield* Activation,
			links = yield* Links,
			registry = yield* RunHandlers;
		const bindings = () =>
			Clock.currentTimeMillis.pipe(
				Effect.map((ms) => ({
					now: iso(ms),
					today: new Intl.DateTimeFormat('en-CA', {
						timeZone: manifest.workspace.tz,
						year: 'numeric',
						month: '2-digit',
						day: '2-digit'
					}).format(new Date(ms)),
					tz: manifest.workspace.tz,
					params: {}
				}))
			);
		const service = makeOutbound({
			crypto: yield* Crypto.Crypto,
			engine: {
				manifest,
				db,
				act: writes.act,
				read: reads.run,
				authority: identity.authority,
				live,
				bindings
			},
			guest,
			links: drivers,
			send: links.send,
			files,
			announce: wake.at,
			epoch: activation.epoch
		});
		yield* registry.register(service.handlers);
		return { ...service, deliver: service.deliver(), activate: service.activate() };
	})
);
