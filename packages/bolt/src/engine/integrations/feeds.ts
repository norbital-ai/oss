// Feeds (§4.1): an integration's inbound rows. One page per invocation — a `read` body's (pulled on the feed's cron, in a
// sync-kind isolate), a pushing driver's items through `map`, or the instance's conversation messages through `map` — is
// committed as ONE act statement on the feed's collection: its upserts by the model key (the instance FK, stamped here,
// and `key`), its removals (a delete, or the `removed` patch), the `bolt_feed` cursor by compare-and-set and the
// `bolt_feed_row` markers. A snapshot is a new cycle of markers: it begins at a read from no cursor (a first read, or
// after `retained: false` — the source lost its history — or a changed literal) or at a page marked `snapshot: 'begin'`;
// after the page marked `snapshot: 'end'` the rows of older cycles are reconciled through `removed`, 1000 at a time, resumably.
// A changed feed literal (its digest) starts again from no cursor; a code-only release does not. The run `<def>.<feed>`
// takes the definition's active instances × partitions, one failing instance never holding the others back; its health
// lands on `sys_integration.status.health` only when it changes. Writes run as the feed (`{ by: { integration, instance,
// feed } }`), admitted by no grant: the act admits only the feed's collection and only its non-local fields.
import { Clock, Crypto, Effect, Layer, Predicate, Schema } from 'effect';
import { localOf } from '@norbital-ai/std/zone';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Drivers } from '../ports.ts';
import { filesOf } from '../conversations/store.ts';
import {
	Feeds,
	Guest,
	Identity,
	Manifest,
	Reads,
	RunHandlers,
	Writes,
	Wake,
	Live,
	type GuestShape,
	type RunHandler
} from '../services.ts';
import type { Bindings } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { enqueue, nextDue } from '../runs/queue.ts';
import { embedRun, EMBED } from './embed.ts';
import { Port } from '../port.ts';
import { iso } from '../runs/time.ts';
import type { Json } from '../../decl/values.ts';
import { DRIVERS, type FeedSpec } from '../../decl/runtime/integration.ts';
import { q, SYSTEM_COLUMNS } from '../../protocol/catalog.ts';
import { catalogOf } from '../access/pred.ts';
import {
	LIMITS,
	type Authority,
	type EngineActor,
	type Outcome,
	type RowData
} from '../contracts.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { modelKey } from '../write/flatten.ts';
import { canonical, Chain, GATED, sha256Hex, databaseValue } from '../write/sql.ts';
import { instancesOf, integrationBody, writeStatus, type Instance } from './instances.ts';
/** One declared feed: the run `<def>.<feed>`, its target, the instance FK and what it writes (every stored field but the local ones). */
type Feed = {
	run: string;
	definition: string;
	name: string;
	spec: FeedSpec;
	into: string;
	fk: string;
	key: readonly string[];
	from: 'read' | 'driver' | 'messages';
	fields: readonly string[];
	local: readonly string[];
};
const memo = new WeakMap<
	EngineManifest,
	{
		runs: ReadonlyMap<string, Feed>;
		fed: ReadonlyMap<string, Feed>;
	}
>();
const index = (m: EngineManifest) => {
	let x = memo.get(m);
	if (x === undefined) {
		const cat = catalogOf(m);
		const runs = new Map(
			Object.entries(m.integrations).flatMap(([definition, def]) =>
				Object.entries(def.feeds ?? {}).map(([name, spec]): [string, Feed] => {
					// a feed target's local fields are its `update` columns (§2.1): only they change locally, and the feed never writes them
					const local = m.collections[spec.into]?.update?.input.columns ?? [];
					const fields = [...(cat.models.get(spec.into)?.fields.values() ?? [])]
						.filter(
							(f) =>
								!f.computed &&
								!f.derived &&
								!(SYSTEM_COLUMNS as readonly string[]).includes(f.name) &&
								!local.includes(f.name)
						)
						.map((f) => f.name);
					return [
						`${definition}.${name}`,
						{
							run: `${definition}.${name}`,
							definition,
							name,
							spec,
							into: spec.into,
							key: spec.key,
							from: spec.from ?? 'read',
							fk: modelKey(m, spec.into).find((f) => !spec.key.includes(f)) ?? '',
							fields,
							local
						}
					];
				})
			)
		);
		memo.set(m, (x = { runs, fed: new Map([...runs.values()].map((f) => [f.into, f])) }));
	}
	return x;
};
/** Every feed by its run name `<def>.<feed>`. */
export const feedsOf = (m: EngineManifest): ReadonlyMap<string, Feed> => index(m).runs;
/** The feed that writes each fed collection (one per collection, `load/feed-target`). */
export const fedOf = (m: EngineManifest): ReadonlyMap<string, Feed> => index(m).fed;
/**
 * hook:integrations (write/commit.ts) — a committed instance whose configuration or pause changed (or a new one) queues
 * one run of each feed its definition pulls or is pushed, for it alone: a partition it now names reads at once, one it
 * dropped drains, without waiting for a cron slot or the driver.
 */
export function feedConfigurationPiece(
	m: EngineManifest,
	c: Chain,
	now: string,
	source = 'allp'
): void {
	const runs = [...feedsOf(m).values()]
		.filter((f) => f.from !== 'messages')
		.map((f) => ({ d: f.definition, run: f.run }));
	if (runs.length === 0) return;
	enqueue(
		c,
		{
			select: `SELECT gen_random_uuid()::text AS id, d.run AS automation, jsonb_build_object('instance', p.id) AS input, ${c.p(now)}::timestamptz AS due_at,
			jsonb_build_array('feed:configured', d.run, p.id, p.revision)::text AS key, 'configured'::text AS cause, 0 AS depth
		FROM ${source} p JOIN jsonb_to_recordset(${c.p(runs)}::jsonb) AS d(d text, run text) ON p.n ->> 'integration' = d.d
		WHERE ${GATED} AND p.c = 'sys_integration' AND p.n IS NOT NULL AND (p.n ->> 'active')::boolean
			AND (p.o IS NULL OR p.o -> 'configuration' IS DISTINCT FROM p.n -> 'configuration' OR p.o -> 'active' IS DISTINCT FROM p.n -> 'active')`
		},
		{ conflict: 'keep' }
	);
}
/** Feed runs for an ingested message; a recall is distinct even when the provider retains the original version. */
export const messageFeedRuns = (
	m: EngineManifest,
	definition: string,
	instance: string,
	message: string,
	version: string,
	deleted = false
): {
	automation: string;
	key: string;
	input: Json;
}[] =>
	[...feedsOf(m).values()]
		.filter((f) => f.definition === definition && f.from === 'messages')
		.map((f) => ({
			automation: f.run,
			key: JSON.stringify(['feed', f.run, message, version, ...(deleted ? [true] : [])]),
			input: { instance, messages: [message] }
		}));
type Obj = {
	readonly [k: string]: Json;
};
const READY: Health = { state: 'ready' };
/** Changes a page commits at most (rule 25a). */
const PAGE_CHANGES = 1000;
/** Pages a run reads before it queues its continuation. */
export const PAGES = 1000;
const HealthSchema = Schema.Struct({
	state: Schema.Literals(['ready', 'attention']),
	code: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Schema.String)
});
const ChangeSchema = Schema.Union([
	Schema.Struct({ upsert: Schema.Record(Schema.String, Schema.Json) }),
	Schema.Struct({ delete: Schema.Record(Schema.String, Schema.Json) })
]);
export const PageSchema = Schema.Struct({
	changes: Schema.Array(ChangeSchema).check(Schema.isMaxLength(PAGE_CHANGES)),
	cursor: Schema.Json,
	more: Schema.Boolean,
	snapshot: Schema.optionalKey(Schema.Literals(['begin', 'end'])),
	retained: Schema.optionalKey(Schema.Literal(false)),
	health: Schema.optionalKey(HealthSchema)
});
type Health = typeof HealthSchema.Type;
type Change = typeof ChangeSchema.Type;
type Page = typeof PageSchema.Type;
const StateSchema = Schema.Struct({
	cursor: Schema.Json,
	cycle: Schema.Number,
	phase: Schema.Literals(['read', 'reconcile']),
	version: Schema.Number,
	health: Schema.NullOr(HealthSchema),
	digest: Schema.String
});
type State = typeof StateSchema.Type;
const StoredState = Schema.Struct({
	...StateSchema.fields,
	feed: Schema.String,
	instance: Schema.String,
	partition: Schema.String
});
const decodePage = (feed: Feed, value: Json, where: string) =>
	Schema.decodeUnknownEffect(PageSchema)(value, { errors: 'all', onExcessProperty: 'error' }).pipe(
		Effect.mapError((error) =>
			BoltError.make('badAnswer', 'guest', `${feed.run}: ${where} ${error.message}`)
		),
		Effect.flatMap((page) => {
			for (const change of page.changes) {
				const row = 'upsert' in change ? change.upsert : change.delete;
				const missing = feed.key.find((key) => row[key] === undefined || row[key] === null);
				if (missing !== undefined)
					return Effect.fail(
						BoltError.make('badAnswer', 'guest', `${feed.run}: ${where} has no ${missing}`)
					);
			}
			return Effect.succeed(page);
		})
	);
/** A remote key as one text (the marker's `key`) and its values as the text SQL compares them by. */
const keyOf = (f: Feed, row: Obj) => {
	const values = f.key.map((k) => databaseValue(row[k] ?? null));
	return {
		key: JSON.stringify(values),
		v: values.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
	};
};
const keyMatch = (f: Feed, row: (field: string) => string, v: string) =>
	f.key.map((k, i) => `${row(k)} = ${v} ->> ${i}`).join(' AND ');
const worst = (all: Iterable<Health | null>): Health => {
	for (const h of all) if (h?.state === 'attention') return h;
	return READY;
};
type FeedsConfig = {
	crypto: Crypto.Crypto;
	engine: {
		manifest: EngineManifest;
		db: TenantDbShape;
		act: Writes['Service']['act'];
		read: Reads['Service']['run'];
		authority: Identity['Service']['authority'];
		bindings: () => Effect.Effect<Bindings>;
	};
	guest: GuestShape;
	links: Drivers['Service'];
	announce: (at: string) => Effect.Effect<void>;
	status: (
		instance: string,
		patch: {
			readonly [key: string]: Json;
		}
	) => Effect.Effect<void, EngineError>;
};
function makeFeeds(cfg: FeedsConfig) {
	const { manifest: m, db } = cfg.engine;
	const bodies = {
		manifest: m,
		db,
		read: cfg.engine.read,
		bindings: cfg.engine.bindings,
		guest: cfg.guest,
		links: cfg.links
	};
	/** One feed run's work for one instance, as the feed's actor. */
	function session(f: Feed, inst: Instance, run: string, authority: Authority) {
		const actor: EngineActor = {
			kind: 'system',
			run,
			by: { integration: f.definition, instance: inst.id, feed: f.name }
		};
		let n = 0;
		return { f, inst, run, actor, authority, id: () => `${run}:${inst.id}:${n++}` };
	}
	type Session = ReturnType<typeof session>;
	/** The cursor compare-and-set, as a piece of the page's act or alone. */
	const feedRow = (s: Session, partition: string, state: State, next: State) =>
		[
			`INSERT INTO bolt_feed (feed, instance, partition, cursor, cycle, phase, health, digest, version)`,
			[
				s.f.run,
				s.inst.id,
				partition,
				next.cursor === null ? null : JSON.stringify(next.cursor),
				next.cycle,
				next.phase,
				JSON.stringify(next.health),
				next.digest,
				state.version + 1
			] as Json[],
			`ON CONFLICT (feed, instance, partition) DO UPDATE SET cursor = excluded.cursor, cycle = excluded.cycle, phase = excluded.phase, health = excluded.health,
			digest = excluded.digest, version = excluded.version WHERE bolt_feed.version = ${state.version} RETURNING version`
		] as const;
	const advance = Effect.fn('Feeds.advance')(function* (
		s: Session,
		partition: string,
		state: State,
		next: State,
		gone: readonly string[] = []
	) {
		if (
			gone.length === 0 &&
			state.version > 0 &&
			canonical([state.cursor, state.cycle, state.phase, state.health, state.digest]) ===
				canonical([next.cursor, next.cycle, next.phase, next.health, next.digest])
		)
			return state;
		const [insert, params, conflict] = feedRow(s, partition, state, next);
		const res = yield* db.write({
			text: `WITH f AS (${insert} SELECT $1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9 ${conflict}),
			gone AS (DELETE FROM bolt_feed_row WHERE feed = $1 AND instance = $2 AND partition = $3 AND key IN (SELECT jsonb_array_elements_text($10::jsonb))
				AND EXISTS (SELECT 1 FROM f) RETURNING 1)
			SELECT (SELECT count(*) FROM f)::int AS n`,
			params: [...params, JSON.stringify(gone)]
		});
		if (res.rows[0]?.['n'] !== 1)
			return yield* Effect.fail(
				BoltError.make(
					'conflict',
					'commit',
					`${s.f.run}: another run advanced ${s.inst.id}'s cursor`
				)
			);
		return { ...next, version: state.version + 1 };
	});
	const write = Effect.fn('Feeds.write')(function* (
		s: Session,
		partition: string,
		state: State,
		next: State,
		upserts: readonly Obj[],
		removals: readonly (
			| {
					target: string;
			  }
			| {
					target: string;
					set: RowData;
			  }
		)[],
		gone: readonly string[]
	) {
		const f = s.f,
			b = yield* cfg.engine.bindings();
		const marks = upserts.map((row) => keyOf(f, row));
		const key = JSON.stringify(['feed', f.run, s.inst.id, partition, state.version]);
		const pieces = (c: Chain) => {
			const [insert, params, conflict] = feedRow(s, partition, state, next);
			const p = params.map((v, i) => (i === 3 || i === 6 ? `${c.p(v)}::jsonb` : c.p(v)));
			c.cte('feed_cursor', `${insert} SELECT ${p.join(', ')} WHERE ${GATED} ${conflict}`);
			c.assert(
				'(SELECT count(*) FROM feed_cursor) = 1',
				'conflict',
				JSON.stringify({ collection: 'bolt_feed', ids: [f.run] })
			);
			const [run, inst, part] = [c.p(f.run), c.p(s.inst.id), c.p(partition)];
			if (marks.length > 0)
				c.cte(
					'feed_marks',
					`INSERT INTO bolt_feed_row (feed, instance, partition, key, record, cycle)
				SELECT ${run}, ${inst}, ${part}, k.key, coalesce(
					(SELECT x.id FROM allp x WHERE x.c = ${c.p(f.into)} AND x.op = 'create' AND ${keyMatch(f, (field) => `x.n ->> ${c.p(field)}`, 'k.v')}),
					(SELECT t.id::text FROM ${q(f.into)} t WHERE t.${q(f.fk)}::text = ${inst} AND ${keyMatch(f, (field) => `t.${q(field)}::text`, 'k.v')})), ${c.p(next.cycle)}
				FROM jsonb_to_recordset(${c.p(marks)}::jsonb) AS k(key text, v jsonb) WHERE ${GATED}
				ON CONFLICT (feed, instance, partition, key) DO UPDATE SET record = excluded.record, cycle = excluded.cycle`
				);
			if (gone.length > 0)
				c.cte(
					'feed_gone',
					`DELETE FROM bolt_feed_row WHERE feed = ${run} AND instance = ${inst} AND partition = ${part}
				AND key IN (SELECT jsonb_array_elements_text(${c.p(gone)}::jsonb)) AND ${GATED}`
				);
		};
		const o: Outcome = (yield* cfg.engine.act({
			collection: f.into,
			verb: 'upsert',
			onConflict: 'update',
			input: upserts,
			key,
			issuedAt: b.now,
			authority: s.authority,
			bindings: b,
			invocationId: key,
			mode: { _tag: 'Feed', fields: f.fields, removals, pieces }
		})).outcome;
		if (o.kind !== 'committed')
			return yield* Effect.fail(
				BoltError.make(
					o.kind === 'refused' ? o.code : o.kind,
					'commit',
					`${f.run}: the page for ${s.inst.id} was not committed${o.kind === 'refused' ? `: ${o.message}` : ''}`
				)
			);
		return { ...next, version: state.version + 1 };
	});
	const commit = Effect.fn('Feeds.commit')(function* (
		s: Session,
		partition: string,
		state: State,
		page: Page
	) {
		const f = s.f;
		const next: State = {
			...state,
			cursor: page.cursor,
			cycle: page.snapshot === 'begin' || state.cursor === null ? state.cycle + 1 : state.cycle,
			phase: page.snapshot === 'end' ? 'reconcile' : 'read',
			health: page.health ?? READY
		};
		const last = new Map<string, Change>();
		for (const c of page.changes) {
			const k = keyOf(f, 'upsert' in c ? c.upsert : c.delete).key;
			last.delete(k);
			last.set(k, c);
		}
		const upserts = [...last.values()].flatMap((c) =>
			'upsert' in c ? [{ ...c.upsert, [f.fk]: s.inst.id }] : []
		);
		const deletes = [...last].flatMap(([k, c]) =>
			'delete' in c ? [{ k, ...keyOf(f, c.delete) }] : []
		);
		if (upserts.length === 0 && deletes.length === 0)
			return yield* advance(s, partition, state, next);
		const found =
			deletes.length === 0
				? []
				: ((yield* db.read([
						{
							text: `SELECT k.key, t.id::text AS id FROM jsonb_to_recordset($2::jsonb) AS k(key text, v jsonb)
			JOIN ${q(f.into)} t ON t.${q(f.fk)}::text = $1 AND ${keyMatch(f, (field) => `t.${q(field)}::text`, 'k.v')}`,
							params: [s.inst.id, JSON.stringify(deletes.map((d) => ({ key: d.k, v: d.v })))]
						}
					]))[0]?.rows ?? []);
		const removals = found.map((r) => removal(f, String(r['id'])));
		if (upserts.length === 0 && removals.length === 0)
			return yield* advance(
				s,
				partition,
				state,
				next,
				deletes.map((d) => d.k)
			);
		return yield* write(
			s,
			partition,
			state,
			next,
			upserts,
			removals,
			deletes.map((d) => d.k)
		);
	});
	const removal = (f: Feed, id: string) =>
		f.spec.removed === undefined || f.spec.removed === 'delete'
			? { target: id }
			: { target: id, set: f.spec.removed as RowData };
	const reconcile = Effect.fn('Feeds.reconcile')(function* (
		s: Session,
		partition: string,
		state: State
	) {
		const f = s.f;
		const [res] = yield* db.read([
			{
				text: `SELECT r.key, t.id::text AS id FROM bolt_feed_row r LEFT JOIN ${q(f.into)} t ON t.id::text = r.record
			WHERE r.feed = $1 AND r.instance = $2 AND r.partition = $3 AND r.cycle < $4 ORDER BY r.key LIMIT ${PAGE_CHANGES}`,
				params: [f.run, s.inst.id, partition, state.cycle]
			}
		]);
		const rows = res?.rows ?? [],
			keys = rows.map((r) => String(r['key']));
		const next: State = { ...state, phase: rows.length === PAGE_CHANGES ? 'reconcile' : 'read' };
		const live = rows.flatMap((r) => (r['id'] === null ? [] : [removal(f, String(r['id']))]));
		return yield* live.length === 0
			? advance(s, partition, state, next, keys)
			: write(s, partition, state, next, [], live, keys);
	});
	const read = Effect.fn('Feeds.read')(function* (s: Session, partition: string, cursor: Json) {
		const f = s.f,
			ctx = {
				instance: s.inst.id,
				partition: partition === '' ? null : partition,
				configuration: s.inst.configuration
			};
		const path = `integration_definition.${f.definition}.bodies.feeds.${f.name}`;
		if (f.from === 'read')
			return yield* decodePage(
				f,
				yield* integrationBody(bodies, {
					id: s.id(),
					actor: s.actor,
					path: `${path}.read`,
					args: [cursor, { $ctx: true }],
					...ctx,
					request: true
				}),
				'read'
			);
		const got = yield* cfg.links.read(s.inst.id, f.name, partition, cursor).pipe(
			Port.call(`${f.run} driver`, LIMITS.callMs.http),
			Effect.mapError((error) =>
				BoltError.make(
					error._tag === 'Unavailable' ? 'unavailable' : error.kind,
					'facility',
					`${f.run}: the driver read of ${s.inst.id} failed: ${error._tag === 'Unavailable' ? error.reason : error.message}`
				)
			)
		);
		const { items, ...facts } = got;
		const changes = yield* integrationBody(bodies, {
			id: s.id(),
			actor: s.actor,
			path: `${path}.map`,
			args: [items as Json, { $ctx: true }],
			...ctx
		});
		return yield* decodePage(f, { ...facts, changes }, 'map');
	});
	const partitionRun = Effect.fn('Feeds.partitionRun')(function* (
		s: Session,
		partition: string,
		stored: State | undefined,
		digest: string
	) {
		const f = s.f;
		let state: State =
			stored !== undefined && stored.digest === digest
				? stored
				: {
						cursor: null,
						cycle: stored?.cycle ?? 0,
						phase: 'read',
						version: stored?.version ?? 0,
						health: stored?.health ?? null,
						digest
					};
		let pages = 0,
			done = false;
		for (;;) {
			if (state.phase !== 'reconcile' && done) return { state, pages };
			if (pages >= PAGES) {
				// rule 25a: a continuation run resumes this instance and partition, never an in-process loop past the cap
				const at = iso(yield* Clock.currentTimeMillis);
				const c = new Chain();
				enqueue(
					c,
					[
						{
							automation: f.run,
							input: { instance: s.inst.id, partition },
							dueAt: at,
							key: JSON.stringify(['feed:continue', f.run, s.inst.id, partition, state.version]),
							cause: 'continue',
							depth: 0
						}
					],
					{ conflict: 'keep' }
				);
				yield* db.write(c.sql('NULL AS outcome'));
				yield* cfg.announce(at);
				return { state, pages };
			}
			pages++;
			if (state.phase === 'reconcile') {
				state = yield* reconcile(s, partition, state);
				continue;
			}
			const page = yield* read(s, partition, state.cursor);
			if (page.retained === false) {
				if (state.cursor === null)
					return yield* Effect.fail(
						BoltError.make(
							'noProgress',
							'commit',
							`${f.run}: the source lost its history even from no cursor`
						)
					);
				state = yield* advance(s, partition, state, {
					...state,
					cursor: null,
					phase: 'read',
					health: page.health ?? READY
				});
				continue;
			}
			if (page.more && canonical(page.cursor) === canonical(state.cursor))
				return yield* Effect.fail(
					BoltError.make('noProgress', 'commit', `${f.run}: the page answered its own cursor again`)
				);
			state = yield* commit(s, partition, state, page);
			done = !page.more;
		}
	});
	const messages = Effect.fn('Feeds.messages')(function* (
		s: Session,
		stored: State | undefined,
		digest: string,
		ids: readonly string[]
	) {
		if (ids.length === 0) return stored;
		const f = s.f,
			def = s.inst.definition;
		const kind =
			def.conversation?.kind ??
			('conversation' in DRIVERS[def.driver]
				? (
						DRIVERS[def.driver] as {
							conversation: {
								kind: string;
							};
						}
					).conversation.kind
				: 'chat');
		const [res] = yield* db.read([
			{
				text: `SELECT m.provider_id, m.version, m.sender, m.sender_name, m.sent_at::text AS sent_at, m.text, m.email, ${filesOf('m')} AS files, m.reply_to,
				m.deleted_at IS NOT NULL AS deleted, c.thread, c.kind, c.participants FROM sys_message m LEFT JOIN sys_conversation c ON c.id = m.conversation
			WHERE m.integration = $1 AND m.direction = 'inbound' AND m.id IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY m.seq`,
				params: [s.inst.id, JSON.stringify(ids)]
			}
		]);
		const items = (res?.rows ?? []).map((r): Json => {
			const facts = {
				attachments: r['files'] ?? [],
				version: r['version'] ?? r['sent_at'] ?? '',
				deleted: r['deleted'] === true
			};
			if (kind === 'email')
				return {
					...(Predicate.isObject(r['email']) ? r['email'] : { id: r['provider_id'] ?? '' }),
					...facts
				};
			return {
				id: r['provider_id'] ?? '',
				thread: r['thread'] ?? '',
				sentAt: r['sent_at'] ?? null,
				from: { handle: r['sender'] ?? '', name: r['sender_name'] ?? null },
				replyTo: r['reply_to'] ?? null,
				text: r['text'] ?? '',
				group: r['kind'] === 'group',
				...(Array.isArray(r['participants']) ? { participants: r['participants'] } : {}),
				...facts
			};
		});
		if (items.length === 0) return stored;
		const state: State =
			stored !== undefined && stored.digest === digest
				? stored
				: {
						cursor: null,
						cycle: stored?.cycle ?? 0,
						phase: 'read',
						version: stored?.version ?? 0,
						health: null,
						digest
					};
		const changes = yield* integrationBody(bodies, {
			id: s.id(),
			actor: s.actor,
			path: `integration_definition.${f.definition}.bodies.feeds.${f.name}.map`,
			args: [items, { $ctx: true }],
			instance: s.inst.id,
			partition: null,
			configuration: s.inst.configuration
		});
		return yield* commit(
			s,
			'',
			state,
			yield* decodePage(f, { changes, cursor: null, more: false }, 'map')
		);
	});
	const settle = Effect.fn('Feeds.settle')(function* (
		inst: Instance,
		healths: ReadonlyMap<string, Health | null>
	) {
		const next = worst([...healths].sort(([a], [b]) => a.localeCompare(b)).map(([, h]) => h));
		const prev =
			Predicate.isObject(inst.status) && Predicate.isObject(inst.status['health'])
				? inst.status['health']
				: READY;
		if (canonical(prev) === canonical(next)) return;
		// a notice on a health change is an ordinary automation on `sys_integration` updates
		yield* cfg.status(inst.id, { health: next });
	});
	const run = Effect.fn('Feeds.run')(function* (f: Feed, input: Json, runId: string) {
		// live environments only: a host binds links there and nowhere else, so a preview or a fork reads no feed, records no
		// health and wakes no automation on its instances
		if (!cfg.links.available) return { pages: 0 };
		const x = Predicate.isObject(input) ? input : {};
		const only = typeof x['instance'] === 'string' ? x['instance'] : undefined;
		const instances = (yield* instancesOf(
			m,
			db,
			only === undefined ? { integration: f.definition } : { ids: [only] }
		)).filter((i) => i.active && i.integration === f.definition);
		if (instances.length === 0) return { pages: 0 };
		const stored = yield* db.rows(StoredState, {
			text: `SELECT feed, instance, partition, cursor, cycle, phase, health, digest, version FROM bolt_feed WHERE instance IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(instances.map((instance) => instance.id))]
		});
		const digest = sha256Hex(canonical(f.spec));
		const failures: EngineError[] = [];
		let pages = 0;
		for (const inst of instances) {
			const rows = stored.filter((row) => row.instance === inst.id);
			const healths = new Map(rows.map((row) => [`${row.feed}\u0000${row.partition}`, row.health]));
			const states = new Map(
				rows.filter((row) => row.feed === f.run).map((row): [string, State] => [row.partition, row])
			);
			const s = session(
				f,
				inst,
				runId,
				yield* cfg.engine.authority(
					{
						actor: {
							kind: 'system',
							run: runId,
							by: { integration: f.definition, instance: inst.id, feed: f.name }
						},
						policies: [],
						admin: true
					},
					`feed:${f.run}:${inst.id}`
				)
			);
			let partition = '';
			yield* Effect.gen(function* () {
				if (f.from === 'messages') {
					const done = yield* messages(
						s,
						states.get(''),
						digest,
						Array.isArray(x['messages']) ? x['messages'].map(String) : []
					);
					if (done !== undefined) {
						pages++;
						healths.set(`${f.run}\u0000`, done.health);
					}
				} else {
					const field = f.spec.partitions,
						value =
							field === undefined || !Predicate.isObject(inst.configuration)
								? undefined
								: inst.configuration[field];
					const partitions =
						field === undefined
							? ['']
							: Array.isArray(value)
								? [...new Set(value.map(String))]
								: [];
					// a partition the configuration dropped releases its cursor and markers; its rows stay as they are
					const gone = [...states.keys()].filter((p) => !partitions.includes(p));
					if (gone.length > 0) {
						yield* db.write({
							text: `DELETE FROM bolt_feed WHERE feed = $1 AND instance = $2 AND partition IN (SELECT jsonb_array_elements_text($3::jsonb))`,
							params: [f.run, inst.id, JSON.stringify(gone)]
						});
						for (const p of gone) healths.delete(`${f.run}\u0000${p}`);
					}
					for (partition of typeof x['partition'] === 'string'
						? partitions.filter((p) => p === x['partition'])
						: partitions) {
						const done = yield* partitionRun(s, partition, states.get(partition), digest);
						pages += done.pages;
						healths.set(`${f.run}\u0000${partition}`, done.state.health);
					}
				}
			}).pipe(
				Effect.catch((e) =>
					Effect.gen(function* () {
						failures.push(e);
						const failed: Health = {
							state: 'attention',
							code: e instanceof BoltError ? e.code : 'processingFailure',
							message: e instanceof Error ? e.message.slice(0, 500) : String(e)
						};
						const prior = states.get(partition);
						healths.set(`${f.run}\u0000${partition}`, failed);
						yield* Effect.gen(function* () {
							yield* db.write({
								text: `INSERT INTO bolt_feed (feed, instance, partition, health, digest, cycle, version) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 1)
						ON CONFLICT (feed, instance, partition) DO UPDATE SET health = excluded.health`,
								params: [
									f.run,
									inst.id,
									partition,
									JSON.stringify(failed),
									prior?.digest ?? digest,
									prior?.cycle ?? 0
								]
							});
						}).pipe(
							Effect.catch((written) =>
								Effect.gen(function* () {
									failures.push(written);
								})
							)
						);
					})
				)
			);
			yield* Effect.gen(function* () {
				yield* settle(inst, healths);
			}).pipe(
				Effect.catch((e) =>
					Effect.gen(function* () {
						failures.push(e);
					})
				)
			);
		}
		if (failures.length > 0)
			return yield* Effect.fail(
				failures[0] ?? BoltError.make('internal', 'commit', 'the feed failed')
			);
		return { pages };
	});
	return {
		/** The platform runs `<def>.<feed>`, for the runs area's `platform` map (rule 48). */
		handlers: Object.fromEntries(
			[...feedsOf(m).values()].map((feed): [string, RunHandler] => [
				feed.run,
				(input, runInfo) => run(feed, input, runInfo.id)
			])
		),
		retries: Object.fromEntries(
			[...feedsOf(m).values()]
				.filter((feed) => feed.from !== 'read')
				.map((feed) => [feed.run, { attempts: 3, backoff: '10s' }])
		),
		invalidate: Effect.fn('Feeds.invalidate')(function* (
			instance: string,
			feed: string,
			partition: string
		) {
			const [inst] = yield* instancesOf(m, db, { ids: [instance] });
			const f = inst === undefined ? undefined : feedsOf(m).get(`${inst.integration}.${feed}`);
			if (f === undefined || f.from !== 'driver')
				return yield* Effect.fail(
					BoltError.make('invalidInput', 'decode', `'${instance}' has no driver feed '${feed}'`)
				);
			const at = iso(yield* Clock.currentTimeMillis),
				input = JSON.stringify({ instance, partition });
			const c = new Chain();
			enqueue(
				c,
				[
					{
						automation: f.run,
						input: { instance, partition },
						dueAt: at,
						cause: 'provider',
						depth: 0
					}
				],
				{
					when: `NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = ${c.p(f.run)} AND state = 'queued' AND input = ${c.p({ instance, partition })}::jsonb)`
				}
			);
			yield* db.write(c.sql('NULL AS outcome'));
			yield* cfg.announce(at);
		}),
		test: Effect.fn('Feeds.test')(function* (instance: string) {
			const [inst] = yield* instancesOf(m, db, { ids: [instance] });
			if (inst === undefined)
				return yield* Effect.fail(
					BoltError.make('notFound', 'decode', `No integration instance '${instance}'.`)
				);
			if (m.integrations[inst.integration]?.test !== true || cfg.guest === undefined) return;
			const id = yield* cfg.crypto.randomUUIDv4.pipe(
				Effect.mapError((error) =>
					BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
				)
			);
			yield* integrationBody(bodies, {
				id,
				actor: { kind: 'system', run: id, by: { platform: `${inst.integration}.test` } },
				path: `integration_definition.${inst.integration}.bodies.test`,
				args: [{ $ctx: true }],
				instance,
				configuration: inst.configuration,
				request: true
			});
		})
	};
}

export const FeedsLive = Layer.effect(
	Feeds,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			writes = yield* Writes,
			reads = yield* Reads,
			identity = yield* Identity,
			guest = yield* Guest,
			drivers = yield* Drivers,
			wake = yield* Wake,
			live = yield* Live,
			registry = yield* RunHandlers;
		const context = yield* Effect.context<TenantDb | Manifest | Live | Wake>();
		const bindings = () =>
			Clock.currentTimeMillis.pipe(
				Effect.map((ms) => ({
					now: iso(ms),
					today: localOf(ms, manifest.workspace.tz).date,
					tz: manifest.workspace.tz,
					params: {}
				}))
			);
		const service = makeFeeds({
			crypto: yield* Crypto.Crypto,
			engine: {
				manifest,
				db,
				act: writes.act,
				read: reads.run,
				authority: identity.authority,
				bindings
			},
			guest,
			links: drivers,
			announce: wake.at,
			status: (instance, patch) => writeStatus(instance, patch).pipe(Effect.provideContext(context))
		});
		const embedding = yield* embedRun;
		yield* registry.register({ ...service.handlers, [EMBED]: embedding }, service.retries);
		return service;
	})
);
