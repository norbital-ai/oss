// A remote sync's read (spec §3.1): the run `'<model>.sync.<sync>'` reads each active instance (× partition) from its
// cursor. One page per guest call — what `read` returns from the cursor, the driver's pushed `items` (calendar) and the
// deliveries the inbox holds for it (webhooks, a conversation's messages and the reports of messages the sync sent) — is
// committed as ONE act statement on the sync's model (H4 `Sync` mode, judged by no grant, writing only the fields the
// page returned): its upserts by record id, its deletes, the `sys_sync` cursor by compare-and-set, the `sys_sync_row` id
// map with each row's remote version and snapshot cycle, and the consumed deliveries. A remote row is its `$id` (else its
// model key's values); the id map names its record, else a stored row with the same key is adopted, else a record id is
// minted from the remote id, replay-stably. `$version`: an older version never overwrites a newer one. A snapshot is a
// new cycle of the id map: it begins at a read from no cursor (a first read, `retained: false`, a changed declaration)
// or a page marked `snapshot: 'begin'`; after the page marked `'end'` the records of older cycles are deleted, 1000 at a
// time, resumably. One failing instance never holds the others back; its health lands on `sys_integration.status.health`
// only when it changes.
import { Clock, Effect, Predicate, Schema } from 'effect';
import { dec } from '@norbital-ai/std/decimal';
import { canonical, databaseValue, q, sha256Hex } from '@norbital-ai/store';
import { DRIVERS } from '../../decl/runtime/integration.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS, type Authority, type DriverPage, type EngineActor } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { Port } from '../port.ts';
import { enqueue } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { modelKey } from '../write/flatten.ts';
import { Chain, GATED } from '../write/sql.ts';
import { filesOf, stableId } from '../conversations/store.ts';
import {
	conversationOf,
	instancesOf,
	integrationBody,
	type Instance
} from '../integrations/instances.ts';
import { syncActor, syncsOf, type RemoteSync, type SyncEngine } from './index.ts';

type Obj = { readonly [k: string]: Json };
/** Rows a page commits at most (rule 25a). */
const PAGE_ROWS = 1000;
/** Pages a run reads before it queues its continuation. */
export const PAGES = 1000;
const HealthSchema = Schema.Struct({
	state: Schema.Literals(['ready', 'attention']),
	code: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Schema.String)
});
type Health = typeof HealthSchema.Type;
const READY: Health = { state: 'ready' };
const SyncRowSchema = Schema.Record(Schema.String, Schema.Json).check(
	Schema.makeFilter((row) =>
		(row['$id'] === undefined || typeof row['$id'] === 'string') &&
		(row['$version'] === undefined || typeof row['$version'] === 'string') &&
		(row['$deleted'] === undefined || row['$deleted'] === true)
			? undefined
			: 'a row marks `$id` and `$version` with text and `$deleted` with true'
	)
);
const ResultSchema = Schema.Struct({
	rows: Schema.Array(SyncRowSchema).check(Schema.isMaxLength(PAGE_ROWS)),
	cursor: Schema.optionalKey(Schema.Json),
	more: Schema.optionalKey(Schema.Boolean),
	snapshot: Schema.optionalKey(Schema.Literals(['begin', 'end'])),
	retained: Schema.optionalKey(Schema.Literal(false)),
	health: Schema.optionalKey(HealthSchema)
});
/** One page as the run commits it: what `read` returned, its defaults filled from the driver's page and the cursor. */
type Page = {
	readonly rows: readonly Obj[];
	readonly cursor: Json;
	readonly more: boolean;
	readonly snapshot?: 'begin' | 'end' | undefined;
	readonly retained?: false | undefined;
	readonly health?: Health | undefined;
};
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
	sync: Schema.String,
	instance: Schema.String,
	partition: Schema.String
});
/** One id map entry a page writes: the remote row, its record and the remote version last seen. */
type Mark = {
	readonly rid: string;
	readonly record: string;
	readonly version: string | null;
};
/** What a page leaves besides its act: id map entries, released remote ids and consumed deliveries. */
type Effects = {
	readonly marks: readonly Mark[];
	readonly gone: readonly string[];
	readonly consumed: readonly string[];
	readonly changed: boolean;
};
const NONE: Effects = { marks: [], gone: [], consumed: [], changed: false };
const worst = (all: Iterable<Health | null>): Health => {
	for (const h of all) if (h?.state === 'attention') return h;
	return READY;
};
/** Whether remote version `a` is newer than `b`: numbers and ISO instants compare by value; any other change is newer. */
export const remoteVersionNewer = (a: string, b: string): boolean => {
	if (a === b) return false;
	if (/^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(b)) return dec(a).gt(dec(b));
	const [x, y] = [Date.parse(a), Date.parse(b)];
	return /^\d{4}-\d{2}-\d{2}/.test(a) &&
		/^\d{4}-\d{2}-\d{2}/.test(b) &&
		Number.isFinite(x) &&
		Number.isFinite(y)
		? x > y
		: true;
};
const text = (v: Json) => {
	const x = databaseValue(v);
	return typeof x === 'string' ? x : JSON.stringify(x);
};

export function makeRead(e: SyncEngine) {
	const { manifest: m, db } = e;
	/** One read run's work on one instance, as that sync's actor. */
	function session(s: RemoteSync, inst: Instance, run: string, authority: Authority) {
		const actor: EngineActor = syncActor(s, inst.id, run);
		let n = 0;
		return { s, inst, run, actor, authority, id: () => `${run}:${inst.id}:${n++}` };
	}
	type Session = ReturnType<typeof session>;
	/**
	 * The page's state pieces: the cursor compare-and-set, then (only when it held) the id map entries, the released remote
	 * ids and the consumed deliveries. `gate` is the act's statement gate, `true` for a page that writes no row.
	 */
	const statePieces = (
		c: Chain,
		x: Session,
		partition: string,
		state: State,
		next: State,
		now: string,
		fx: Effects,
		gate: string,
		revision: (record: string) => string
	) => {
		const [sync, inst, part] = [c.p(x.s.name), c.p(x.inst.id), c.p(partition)];
		c.cte(
			'sync_cursor',
			`INSERT INTO sys_sync (id, sync, instance, partition, cursor, cycle, phase, health, digest, version, last_read_at, last_change_at)
			SELECT gen_random_uuid(), ${sync}, ${inst}, ${part}, ${c.p(next.cursor === null ? null : JSON.stringify(next.cursor))}::jsonb,
				${c.p(next.cycle)}, ${c.p(next.phase)}, ${c.p(JSON.stringify(next.health))}::jsonb, ${c.p(next.digest)}, ${c.p(state.version + 1)},
				${c.p(now)}::timestamptz, ${c.p(fx.changed ? now : null)}::timestamptz WHERE ${gate}
			ON CONFLICT (sync, instance, partition) DO UPDATE SET cursor = excluded.cursor, cycle = excluded.cycle, phase = excluded.phase,
				health = excluded.health, digest = excluded.digest, version = excluded.version, last_read_at = excluded.last_read_at,
				last_change_at = coalesce(excluded.last_change_at, sys_sync.last_change_at)
			WHERE sys_sync.version = ${c.p(state.version)} RETURNING version`
		);
		const after = `${gate} AND EXISTS (SELECT 1 FROM sync_cursor)`;
		if (fx.marks.length > 0)
			c.cte(
				'sync_marks',
				`INSERT INTO sys_sync_row (id, sync, instance, partition, remote_id, record, remote_version, cycle, acked_revision)
				SELECT gen_random_uuid(), ${sync}, ${inst}, ${part}, k.rid, k.record, k.version, ${c.p(next.cycle)}, ${revision('k.record')}
				FROM jsonb_to_recordset(${c.p(fx.marks)}::jsonb) AS k(rid text, record text, version text) WHERE ${after}
				ON CONFLICT (sync, instance, remote_id) DO UPDATE SET record = excluded.record, partition = excluded.partition,
					remote_version = coalesce(excluded.remote_version, sys_sync_row.remote_version), cycle = excluded.cycle,
					acked_revision = coalesce(excluded.acked_revision, sys_sync_row.acked_revision)`
			);
		if (fx.gone.length > 0)
			c.cte(
				'sync_gone',
				`DELETE FROM sys_sync_row WHERE sync = ${sync} AND instance = ${inst}
				AND remote_id IN (SELECT jsonb_array_elements_text(${c.p(fx.gone)}::jsonb)) AND ${after}`
			);
		if (fx.consumed.length > 0)
			c.cte(
				'sync_consumed',
				`UPDATE sys_inbox SET consumed_at = ${c.p(now)}::timestamptz WHERE consumed_at IS NULL
				AND id::text IN (SELECT jsonb_array_elements_text(${c.p(fx.consumed)}::jsonb)) AND ${after}`
			);
	};
	/** A page that writes no row: its state pieces alone, in one statement. */
	const advance = Effect.fn('Syncs.advance')(function* (
		x: Session,
		partition: string,
		state: State,
		next: State,
		fx: Effects = NONE
	) {
		const c = new Chain(),
			now = iso(yield* Clock.currentTimeMillis);
		statePieces(c, x, partition, state, next, now, fx, 'true', () => 'NULL::int');
		const rows = yield* db.returning(
			Schema.Struct({ n: Schema.Number }),
			c.sql('(SELECT count(*) FROM sync_cursor)::int AS n')
		);
		if (rows[0]?.n !== 1)
			return yield* Effect.fail(
				BoltError.make(
					'conflict',
					'commit',
					`${x.s.name}: another run advanced ${x.inst.id}'s cursor`
				)
			);
		return { ...next, version: state.version + 1 };
	});
	/** A page that writes rows: one act on the sync's model, its state pieces in the same statement. */
	const write = Effect.fn('Syncs.write')(function* (
		x: Session,
		partition: string,
		state: State,
		next: State,
		upserts: readonly Obj[],
		deletes: readonly string[],
		fx: Effects
	) {
		const s = x.s,
			b = yield* e.bindings();
		const key = JSON.stringify(['sync', s.name, x.inst.id, partition, state.version]);
		const fields = [
			...new Set([
				...upserts.flatMap((row) => Object.keys(row).filter((k) => k !== 'id')),
				...(s.fk === undefined ? [] : [s.fk])
			])
		];
		const pieces = (c: Chain) => {
			statePieces(
				c,
				x,
				partition,
				state,
				next,
				b.now,
				fx,
				GATED,
				(record) =>
					`(SELECT a.revision FROM allp a WHERE a.c = ${c.p(s.model)} AND a.id = ${record})`
			);
			c.assert(
				'(SELECT count(*) FROM sync_cursor) = 1',
				'conflict',
				JSON.stringify({ model: 'sys_sync', ids: [s.name] })
			);
		};
		const o = (yield* e.act({
			model: s.model,
			verb: 'upsert',
			onConflict: 'update',
			input: upserts,
			key,
			issuedAt: b.now,
			authority: x.authority,
			bindings: b,
			invocationId: key,
			mode: { _tag: 'Sync', sync: s.name, instance: x.inst.id, fields, deletes, pieces }
		})).outcome;
		if (o.kind !== 'committed')
			return yield* Effect.fail(
				BoltError.make(
					o.kind === 'refused' ? o.code : o.kind,
					'commit',
					`${s.name}: the page for ${x.inst.id} was not committed${o.kind === 'refused' ? `: ${o.message}` : ''}`
				)
			);
		return { ...next, version: state.version + 1 };
	});
	const commit = Effect.fn('Syncs.commit')(function* (
		x: Session,
		partition: string,
		state: State,
		page: Page,
		consumed: readonly string[]
	) {
		const s = x.s;
		const next: State = {
			...state,
			cursor: page.cursor,
			cycle: page.snapshot === 'begin' || state.cursor === null ? state.cycle + 1 : state.cycle,
			phase: page.snapshot === 'end' ? 'reconcile' : 'read',
			health: page.health ?? READY
		};
		// a row is its `$id`, else its model key's values; the last of a page wins
		const key = modelKey(m, s.model).filter((f) => f !== s.fk);
		const last = new Map<string, Obj>();
		for (const row of page.rows) {
			const rid =
				typeof row['$id'] === 'string'
					? row['$id']
					: key.length > 0 && key.every((k) => row[k] !== undefined && row[k] !== null)
						? JSON.stringify(key.map((k) => text(row[k] ?? null)))
						: undefined;
			if (rid === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'badAnswer',
						'guest',
						`${s.name}: a row has no $id, and ${s.model} has no key to match it by`
					)
				);
			const previous = last.get(rid),
				currentVersion = row['$version'],
				previousVersion = previous?.['$version'];
			if (
				typeof currentVersion === 'string' &&
				typeof previousVersion === 'string' &&
				!remoteVersionNewer(currentVersion, previousVersion)
			)
				continue;
			last.delete(rid);
			last.set(rid, row);
		}
		if (last.size === 0) return yield* advance(x, partition, state, next, { ...NONE, consumed });
		const rids = [...last.keys()];
		const mapped = new Map(
			(yield* db.rows(
				Schema.Struct({
					remote_id: Schema.String,
					record: Schema.String,
					remote_version: Schema.NullOr(Schema.String)
				}),
				{
					text: `SELECT remote_id, record, remote_version FROM sys_sync_row WHERE sync = $1 AND instance = $2
				AND remote_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
					params: [s.name, x.inst.id, JSON.stringify(rids)]
				}
			)).map((r) => [r.remote_id, r])
		);
		// a stored row the id map does not know yet, with this row's key, is adopted (it was there before the sync)
		const unmapped = [...last].filter(
			([rid, row]) =>
				!mapped.has(rid) &&
				key.length > 0 &&
				key.every((k) => row[k] !== undefined && row[k] !== null)
		);
		const adopted = new Map(
			unmapped.length === 0
				? []
				: (yield* db.rows(Schema.Struct({ rid: Schema.String, id: Schema.String }), {
						text: `SELECT k.rid, t.id::text AS id FROM jsonb_to_recordset($1::jsonb) AS k(rid text, v jsonb)
				JOIN ${q(s.model)} t ON ${key.map((f, i) => `t.${q(f)}::text = k.v ->> ${i}`).join(' AND ')}${s.fk === undefined ? '' : ` AND t.${q(s.fk)}::text = $2`}`,
						params: [
							JSON.stringify(
								unmapped.map(([rid, row]) => ({ rid, v: key.map((k) => text(row[k] ?? null)) }))
							),
							...(s.fk === undefined ? [] : [x.inst.id])
						]
					})).map((r) => [r.rid, r.id])
		);
		const upserts: Obj[] = [],
			deletes: string[] = [],
			marks: Mark[] = [],
			gone: string[] = [];
		for (const [rid, row] of last) {
			const known = mapped.get(rid);
			const record = known?.record ?? adopted.get(rid);
			const id = record ?? stableId('sync', s.name, x.inst.id, rid);
			const version = typeof row['$version'] === 'string' ? row['$version'] : null,
				prior = known?.remote_version ?? null;
			const stale = prior !== null && version !== null && !remoteVersionNewer(version, prior);
			marks.push({ rid, record: id, version: stale ? prior : (version ?? prior) });
			if (stale) continue;
			if (row['$deleted'] === true) {
				if (record !== undefined) deletes.push(record);
				continue;
			}
			upserts.push({
				...Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('$'))),
				...(s.fk === undefined ? {} : { [s.fk]: x.inst.id }),
				id
			});
		}
		const fx: Effects = {
			marks,
			gone,
			consumed,
			changed: upserts.length > 0 || deletes.length > 0
		};
		return upserts.length === 0 && deletes.length === 0
			? yield* advance(x, partition, state, next, fx)
			: yield* write(x, partition, state, next, upserts, deletes, fx);
	});
	const reconcile = Effect.fn('Syncs.reconcile')(function* (
		x: Session,
		partition: string,
		state: State
	) {
		const rows = yield* db.rows(
			Schema.Struct({ remote_id: Schema.String, id: Schema.NullOr(Schema.String) }),
			{
				text: `SELECT r.remote_id, t.id::text AS id FROM sys_sync_row r LEFT JOIN ${q(x.s.model)} t ON t.id::text = r.record
			WHERE r.sync = $1 AND r.instance = $2 AND r.partition = $3 AND r.cycle < $4 ORDER BY r.remote_id LIMIT ${PAGE_ROWS}`,
				params: [x.s.name, x.inst.id, partition, state.cycle]
			}
		);
		const next: State = { ...state, phase: rows.length === PAGE_ROWS ? 'reconcile' : 'read' };
		const live = rows.flatMap((r) => (r.id === null ? [] : [r.id]));
		const fx: Effects = { ...NONE, gone: rows.map((r) => r.remote_id), changed: live.length > 0 };
		return yield* live.length === 0
			? advance(x, partition, state, next, fx)
			: write(x, partition, state, next, [], live, fx);
	});
	/** The deliveries the inbox holds for this sync and instance, oldest first, as `read` receives them. */
	const deliveries = Effect.fn('Syncs.deliveries')(function* (x: Session) {
		const rows = yield* db.rows(Schema.Struct({ id: Schema.String, body: Schema.Json }), {
			text: `SELECT id::text AS id, body FROM sys_inbox WHERE sync = $1 AND instance = $2 AND consumed_at IS NULL
			ORDER BY received_at, id LIMIT ${PAGE_ROWS}`,
			params: [x.s.name, x.inst.id]
		});
		const messages = rows.flatMap((r) =>
			Predicate.isObject(r.body) && r.body['kind'] === 'message' && typeof r.body['id'] === 'string'
				? [r.body['id']]
				: []
		);
		const items = new Map(
			messages.length === 0
				? []
				: (yield* messageItems(x.inst, messages)).map((i) => [i.id, i.item])
		);
		return {
			ids: rows.map((r) => r.id),
			deliveries: rows.flatMap((r): Json[] => {
				if (!Predicate.isObject(r.body) || r.body['kind'] !== 'message') return [r.body];
				const item = items.get(String(r.body['id']));
				return item === undefined ? [] : [{ kind: 'message', message: item }];
			})
		};
	});
	/** Inbound conversation messages as a sync's `read` receives them: the message as stored, its version, whether recalled. */
	const messageItems = Effect.fn('Syncs.messageItems')(function* (
		inst: Instance,
		ids: readonly string[]
	) {
		const kind = conversationOf(inst.definition)?.kind ?? 'chat';
		const [res] = yield* db.read([
			{
				text: `SELECT m.id, m.provider_id, m.version, m.sender, m.sender_name, m.sent_at::text AS sent_at, m.text, m.email, ${filesOf('m')} AS files, m.reply_to,
				m.deleted_at IS NOT NULL AS deleted, c.thread, c.kind, c.participants FROM sys_message m LEFT JOIN sys_conversation c ON c.id = m.conversation
			WHERE m.integration = $1 AND m.direction = 'inbound' AND m.id IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY m.seq`,
				params: [inst.id, JSON.stringify(ids)]
			}
		]);
		return (res?.rows ?? []).map((r) => {
			const facts = {
				attachments: r['files'] ?? [],
				version: r['version'] ?? r['sent_at'] ?? '',
				deleted: r['deleted'] === true
			};
			const item: Json =
				kind === 'email'
					? {
							...(Predicate.isObject(r['email']) ? r['email'] : { id: r['provider_id'] ?? '' }),
							...facts
						}
					: {
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
			return { id: String(r['id']), item };
		});
	});
	/** One page: the driver's pushed items from `cursor` (a pushing driver), the inbox's deliveries, then the guest `read`. */
	const read = Effect.fn('Syncs.read')(function* (x: Session, partition: string, cursor: Json) {
		const s = x.s,
			inst = x.inst;
		const pushed: DriverPage | undefined =
			'items' in DRIVERS[inst.definition.driver]
				? yield* e.links.read(inst.id, s.target, partition, cursor).pipe(
						Port.call(`${s.name} driver`, LIMITS.callMs.http),
						Effect.mapError((error) =>
							BoltError.make(
								error._tag === 'Unavailable' ? 'unavailable' : error.kind,
								'facility',
								`${s.name}: the driver read of ${inst.id} failed: ${error._tag === 'Unavailable' ? error.reason : error.message}`
							)
						)
					)
				: undefined;
		const inbox = yield* deliveries(x);
		const answer = yield* integrationBody(e, {
			id: x.id(),
			actor: x.actor,
			kind: 'syncRead',
			target: s.target,
			args: [
				{
					cursor,
					partition: partition === '' ? null : partition,
					instance: inst.id,
					deliveries: inbox.deliveries,
					items: pushed?.items ?? []
				},
				{ $ctx: true }
			],
			instance: inst.id,
			configuration: inst.configuration
		});
		const result = yield* Schema.decodeUnknownEffect(ResultSchema)(answer, {
			errors: 'all',
			onExcessProperty: 'error'
		}).pipe(
			Effect.mapError((error) =>
				BoltError.make('badAnswer', 'guest', `${s.name}: read ${error.message}`)
			)
		);
		const page: Page = {
			rows: result.rows,
			cursor: result.cursor !== undefined ? result.cursor : (pushed?.cursor ?? cursor),
			more: result.more ?? pushed?.more ?? false,
			snapshot: result.snapshot ?? pushed?.snapshot,
			retained: result.retained ?? pushed?.retained,
			health: result.health ?? pushed?.health
		};
		return { page, consumed: inbox.ids };
	});
	const partitionRun = Effect.fn('Syncs.partitionRun')(function* (
		x: Session,
		partition: string,
		stored: State | undefined,
		digest: string
	) {
		const s = x.s;
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
							automation: s.name,
							input: { instance: x.inst.id, partition },
							dueAt: at,
							key: JSON.stringify(['sync:continue', s.name, x.inst.id, partition, state.version]),
							cause: 'continue',
							depth: 0
						}
					],
					{ conflict: 'keep' }
				);
				yield* db.write(c.sql('NULL AS outcome'));
				yield* e.announce(at);
				return { state, pages };
			}
			pages++;
			if (state.phase === 'reconcile') {
				state = yield* reconcile(x, partition, state);
				continue;
			}
			const { page, consumed } = yield* read(x, partition, state.cursor);
			if (page.retained === false) {
				if (state.cursor === null)
					return yield* Effect.fail(
						BoltError.make(
							'noProgress',
							'commit',
							`${s.name}: the source lost its history even from no cursor`
						)
					);
				state = yield* advance(
					x,
					partition,
					state,
					{ ...state, cursor: null, phase: 'read', health: page.health ?? READY },
					{ ...NONE, consumed }
				);
				continue;
			}
			if (page.more && canonical(page.cursor) === canonical(state.cursor))
				return yield* Effect.fail(
					BoltError.make(
						'noProgress',
						'commit',
						`${s.name}: the page answered its own cursor again`
					)
				);
			state = yield* commit(x, partition, state, page, consumed);
			// a full inbox reads on: the next page takes the deliveries this one could not
			done = !page.more && consumed.length < PAGE_ROWS;
		}
	});
	const settle = Effect.fn('Syncs.settle')(function* (
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
		yield* e.status(inst.id, { health: next });
	});
	const run = Effect.fn('Syncs.run')(function* (s: RemoteSync, input: Json, runId: string) {
		// live environments only: a host binds links there and nowhere else, so a preview or a fork reads nothing, records
		// no health and wakes no automation on its instances
		if (!e.links.available) return { pages: 0 };
		const args = Predicate.isObject(input) ? input : {};
		const only = typeof args['instance'] === 'string' ? args['instance'] : undefined;
		const instances = (yield* instancesOf(
			m,
			db,
			only === undefined ? { integration: s.definition } : { ids: [only] }
		)).filter((i) => i.active && i.integration === s.definition);
		if (instances.length === 0) return { pages: 0 };
		const stored = yield* db.rows(StoredState, {
			text: `SELECT sync, instance, partition, cursor, cycle, phase, health, digest, version FROM sys_sync
			WHERE instance IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(instances.map((i) => i.id))]
		});
		// a changed declaration of what is read (its integration, its partitions) starts again from no cursor
		const digest = sha256Hex(canonical({ with: s.definition, partitions: s.partitions ?? null }));
		const failures: EngineError[] = [];
		let pages = 0;
		for (const inst of instances) {
			const rows = stored.filter((row) => row.instance === inst.id);
			const healths = new Map(rows.map((row) => [`${row.sync}\u0000${row.partition}`, row.health]));
			const states = new Map(
				rows
					.filter((row) => row.sync === s.name)
					.map((row): [string, State] => [row.partition, row])
			);
			const work = session(
				s,
				inst,
				runId,
				yield* e.authority(
					{ actor: syncActor(s, inst.id, runId), policies: [], admin: true },
					`sync:${s.name}:${inst.id}`
				)
			);
			let partition = '';
			yield* Effect.gen(function* () {
				const field = s.partitions,
					value =
						field === undefined || !Predicate.isObject(inst.configuration)
							? undefined
							: inst.configuration[field];
				const partitions =
					field === undefined ? [''] : Array.isArray(value) ? [...new Set(value.map(String))] : [];
				// a partition the configuration dropped releases its cursor and id map; its rows stay as they are
				const dropped = [...states.keys()].filter((p) => !partitions.includes(p));
				if (dropped.length > 0) {
					yield* db.write({
						text: `WITH released AS (DELETE FROM sys_sync_row WHERE sync = $1 AND instance = $2 AND partition IN (SELECT jsonb_array_elements_text($3::jsonb)))
						DELETE FROM sys_sync WHERE sync = $1 AND instance = $2 AND partition IN (SELECT jsonb_array_elements_text($3::jsonb))`,
						params: [s.name, inst.id, JSON.stringify(dropped)]
					});
					for (const p of dropped) healths.delete(`${s.name}\u0000${p}`);
				}
				for (partition of typeof args['partition'] === 'string'
					? partitions.filter((p) => p === args['partition'])
					: partitions) {
					const done = yield* partitionRun(work, partition, states.get(partition), digest);
					pages += done.pages;
					healths.set(`${s.name}\u0000${partition}`, done.state.health);
				}
			}).pipe(
				Effect.catch((error) =>
					Effect.gen(function* () {
						failures.push(error);
						const failed: Health = {
							state: 'attention',
							code: error instanceof BoltError ? error.code : 'processingFailure',
							message: error instanceof Error ? error.message.slice(0, 500) : String(error)
						};
						const prior = states.get(partition);
						healths.set(`${s.name}\u0000${partition}`, failed);
						yield* db
							.write({
								text: `INSERT INTO sys_sync (id, sync, instance, partition, health, digest, cycle, version) VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6, 1)
							ON CONFLICT (sync, instance, partition) DO UPDATE SET health = excluded.health`,
								params: [
									s.name,
									inst.id,
									partition,
									JSON.stringify(failed),
									prior?.digest ?? digest,
									prior?.cycle ?? 0
								]
							})
							.pipe(Effect.catch((written) => Effect.sync(() => failures.push(written))));
					})
				)
			);
			yield* settle(inst, healths).pipe(
				Effect.catch((error) => Effect.sync(() => failures.push(error)))
			);
		}
		if (failures.length > 0)
			return yield* Effect.fail(
				failures[0] ?? BoltError.make('internal', 'commit', 'the sync failed')
			);
		return { pages };
	});
	return {
		run,
		/** A pushing driver's `invalidate`: one read of that instance and partition, unless one is queued already. */
		invalidate: Effect.fn('Syncs.invalidate')(function* (
			instance: string,
			sync: string,
			partition: string
		) {
			const [inst] = yield* instancesOf(m, db, { ids: [instance] });
			const s = [...syncsOf(m).values()].find(
				(x) => x.target === sync && x.read && x.definition === inst?.integration
			);
			if (inst === undefined || s === undefined || !('items' in DRIVERS[inst.definition.driver]))
				return yield* Effect.fail(
					BoltError.make('invalidInput', 'decode', `'${instance}' has no pushed sync '${sync}'`)
				);
			const at = iso(yield* Clock.currentTimeMillis);
			const c = new Chain();
			enqueue(
				c,
				[
					{
						automation: s.name,
						input: { instance, partition },
						dueAt: at,
						cause: 'provider',
						depth: 0
					}
				],
				{
					when: `NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = ${c.p(s.name)} AND state = 'queued' AND input = ${c.p({ instance, partition })}::jsonb)`
				}
			);
			yield* db.write(c.sql('NULL AS outcome'));
			yield* e.announce(at);
		})
	};
}
