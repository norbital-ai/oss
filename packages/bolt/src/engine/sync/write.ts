import { actor_id, actor_ref } from '../access/actor.ts';
import { Cause, Clock, Effect, Exit, Schedule, Schema, Semaphore } from 'effect';
import { canonical, q, SYSTEM_COLUMNS } from '@norbital-ai/store';
import type { EngineActor, RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { storedField, storedImageSql } from '../db/stored.ts';
import { msg as messagePiece } from '../conversations/store.ts';
import { catalog_of } from '../access/pred.ts';
import { BoltError } from '../../protocol/errors.ts';
import { is_transient } from '../errors.ts';
import { Chain, GATED, noticeInsert } from '../write/sql.ts';
import { executeCommit } from '../write/commit.ts';
import { rollbackPlan } from '../approvals/rollback.ts';
import { enqueueDrain, next_due } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { ClaimToken, claimedBy, claimSql, LEASE_MS, leaseExpiry, leaseInterval, leaseUntil, renewClaims, retryDelay } from '../queue.ts';
import { instancesOf, integrationBody, retryAfterOf } from '../integrations/instances.ts';
import { syncActor, syncs_of, type SyncEngine } from './index.ts';
import { deliverRun } from '../integrations/outbound.ts';
import { enqueueBackfills } from './backfill.ts';
import { enqueueReplicas, SYNC_DELIVER } from './outbox.ts';
import { replaceVersionSql } from './version.ts';

const ATTEMPTS = 8;
const IDENTITY_CONFLICT = 'The remote identity changed while this delivery was in flight.';
const DELIVERY_BATCH = 32;
const DELIVERY_CONNECTIONS = 4;
const queues = new WeakMap<Chain, number>();
const BACKOFF = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];

/**
 * A frozen outbox image as `write` reads its row, through the read codecs (int8 and numeric cells are stored as text):
 * system columns and declared fields only, and `changed` names only declared fields.
 */
function syncChange(m: EngineManifest, model: string, image: RowData, changed: readonly string[]) {
	const declared = Object.keys(m.models[model]?.fields ?? {}), fields = catalog_of(m).models.get(model)?.fields;
	const columns = (name: string) => {
		const field = fields?.get(name);
		return field?.arms === undefined ? [field?.column ?? name] : field.arms.map((arm) => `${field.column}__${arm}`);
	};
	const touched = new Set(changed);
	return {
		row: Object.fromEntries([...new Set([...SYSTEM_COLUMNS, ...declared, ...(fields?.keys() ?? [])])].flatMap((name) => {
			const field = fields?.get(name), value = field === undefined ? image[name] : storedField(field, image);
			return value === undefined ? [] : [[name, value]];
		})),
		changed: declared.filter((name) => columns(name).some((column) => touched.has(column)))
	};
}

/** The transactional outbox: one entry per sync, instance and row, with the committed image frozen for retries. */
export function syncOutboxPiece(
	m: EngineManifest,
	c: Chain,
	now: string,
	written: ReadonlySet<string>,
	actor: EngineActor,
	source = 'allp',
	options: { preserve_local?: boolean; missing_only?: boolean } = {}
): void {
	const index = queues.get(c) ?? 0;
	queues.set(c, index + 1);
	const syncs = [...syncs_of(m).values()].filter((s) => s.write && written.has(s.model));
	if (syncs.length > 0) {
		// A connection changed in this statement uses its committed image, including a new connection or deactivation.
		const connections = c.cte(`sync_connections${index}`, `
			SELECT i.id::text AS id, i.integration, i.active FROM sys_integration i
			WHERE NOT EXISTS (SELECT 1 FROM ${source} x WHERE x.c = 'sys_integration' AND x.id::text = i.id::text)
			UNION ALL
			SELECT x.id::text AS id, x.n ->> 'integration' AS integration, (x.n ->> 'active')::boolean AS active FROM ${source} x
			WHERE x.c = 'sys_integration' AND x.n IS NOT NULL`);
		const origin = actor.kind === 'system' && 'sync' in actor.by ? actor.by : null;
		const selects = syncs.map((s) => {
			const image = storedImageSql(catalog_of(m), [s.model], 'coalesce(x.n, x.o)');
			const own = origin?.sync === s.name ? `i.id = ${c.p(origin.instance)}` : 'false';
			// built only when used: an unused parameter has no type PostgreSQL can determine
			const uncertain = () => `EXISTS (SELECT 1 FROM sys_outbox o WHERE o.sync = ${c.p(s.name)} AND o.instance = i.id
				AND o.record = x.id AND o.record_revision < x.revision AND o.status IN ('queued', 'sending', 'dead'))`;
			return `SELECT ${c.p(s.name)}::text AS sync, i.id AS instance, x.c AS model, x.id AS record,
				x.op, x.revision AS record_revision, ${image} AS image,
				${c.p(actor_id(actor))}::text AS writer, (${c.p(options.preserve_local === true)}::boolean OR (${own})) AS preserve_local,
				(SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(${image}) k
				 WHERE k NOT IN ('id', 'revision', 'created_at', 'created_by', 'updated_at', 'updated_by')
				 AND (x.op <> 'update' OR x.o -> k IS DISTINCT FROM x.n -> k)) AS changed
			FROM ${source} x JOIN ${connections} i ON i.integration = ${c.p(s.definition)}
			WHERE x.c = ${c.p(s.model)} AND x.cause IN ('direct', 'cascade') AND ${GATED}
			AND (i.active OR EXISTS (SELECT 1 FROM sys_sync_row r
				WHERE r.sync = ${c.p(s.name)} AND r.instance = i.id AND r.record = x.id)
				OR EXISTS (SELECT 1 FROM sys_outbox o WHERE o.sync = ${c.p(s.name)} AND o.instance = i.id
				AND o.record = x.id AND o.status IN ('queued', 'sending', 'dead')))
			${options.missing_only === true ? `AND x.n IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM sys_sync_row r WHERE r.sync = ${c.p(s.name)} AND r.instance = i.id AND r.record = x.id)` : ''}
			AND (NOT (${own}) OR ${options.preserve_local === true ? 'false' : uncertain()})`;
		});
		enqueueReplicas(c, now, selects.join(' UNION ALL '));
	}
	if (written.has('sys_integration')) {
		enqueueBackfills(m, c, now, source);
		enqueueDrain(c, SYNC_DELIVER, c.shared('now', now),
			`EXISTS (SELECT 1 FROM ${source} x WHERE x.c = 'sys_integration' AND x.n ->> 'active' = 'true' AND x.o ->> 'active' IS DISTINCT FROM 'true')`);
		// a connection changed by hand is worth reading now: its syncs' rest ends
		capturePiece(c,
			`rested_${index}`,
			'sys_sync',
			`UPDATE sys_sync SET health = health - 'failures' - 'retry_at' WHERE instance IN (SELECT x.id::text FROM ${source} x WHERE x.c = 'sys_integration' AND (x.n -> 'configuration' IS DISTINCT FROM x.o -> 'configuration' OR x.n -> 'active' IS DISTINCT FROM x.o -> 'active'))`
		);
	}
}

const Outbox = Schema.Struct({
	id: Schema.String,
	sync: Schema.String,
	instance: Schema.String,
	model: Schema.String,
	record: Schema.String,
	op: Schema.Literals(['create', 'update', 'delete']),
	delivery_op: Schema.Literals(['create', 'update', 'delete']),
	record_revision: Schema.Number,
	preserve_local: Schema.Boolean,
	changed: Schema.Array(Schema.String),
	image: Schema.Record(Schema.String, Schema.Json),
	writer: Schema.NullOr(Schema.String),
	key: Schema.String,
	attempts: Schema.Number,
	claimed_at: Schema.String,
	replica_id: Schema.NullOr(Schema.String),
	remote_id: Schema.NullOr(Schema.String),
	remote_version: Schema.NullOr(Schema.String),
	acked_revision: Schema.NullOr(Schema.Number)
});
type Outbox = typeof Outbox.Type;
const replicaUnchanged = (c: Pick<Chain, 'p'>, row: Outbox): string => {
	const replica = `SELECT 1 FROM sys_sync_row WHERE sync = ${c.p(row.sync)} AND instance = ${c.p(row.instance)}
		AND record = ${c.p(row.record)}`;
	return row.replica_id === null ? `NOT EXISTS (${replica})`
		: `EXISTS (${replica} AND id::text = ${c.p(row.replica_id)}
			AND remote_id IS NOT DISTINCT FROM ${c.p(row.remote_id)}::text
			AND remote_version IS NOT DISTINCT FROM ${c.p(row.remote_version)}::text
			AND acked_revision IS NOT DISTINCT FROM ${c.p(row.acked_revision)}::int)`;
};
const Ack = Schema.NullOr(
	Schema.Struct({
		$id: Schema.optionalKey(Schema.String),
		$version: Schema.optionalKey(Schema.String)
	})
);

/** A connection flushes ordinary answers together; refusals retain their atomic rollback path. */
type DeliverySettlement = { readonly row: Outbox } & (
	| { readonly status: 'acked'; readonly result: typeof Ack.Type }
	| { readonly status: 'queued'; readonly at: string; readonly message: string }
	| { readonly status: 'dead' | 'skipped'; readonly message: string; readonly notify?: false }
);

export function makeDeliver(e: SyncEngine) {
	const { db, manifest: m } = e;
	const databases = JSON.stringify(
		e.links.unpaced
			? []
			: Object.entries(m.integrations)
					.filter(([, definition]) => definition.driver === 'sqlserver')
					.map(([name]) => name)
	);
	const ready = (parameter: string) =>
		`(i.integration NOT IN (SELECT jsonb_array_elements_text(${parameter}::jsonb)) OR (i.status ->> 'state' = 'connected' AND i.status -> 'databaseVerified' = 'true'::jsonb))`;
	const schedule = Effect.fn('Syncs.scheduleWrite')(function* (at: string) {
		const c = new Chain();
		enqueueDrain(c, SYNC_DELIVER, c.p(at));
		yield* nativeCommit(db.write, e.live.publish, c, CapturedResult);
		yield* e.announce(at);
	});
	const settleBatch = Effect.fn('Syncs.settleBatch')(function* (results: readonly DeliverySettlement[]) {
		if (results.length === 0) return;
		const now = iso(yield* Clock.currentTimeMillis), c = new Chain();
		c.cte('answers', `SELECT * FROM jsonb_to_recordset(${c.p(results.map((result) => ({
			id: result.row.id, attempts: result.row.attempts, claimed_at: result.row.claimed_at,
			replica_id: result.row.replica_id, observed_id: result.row.remote_id, observed_version: result.row.remote_version,
			status: result.status,
			next_attempt_at: result.status === 'queued' ? result.at : null,
			error: result.status === 'acked' ? null : { message: result.message },
			result: result.status === 'acked' ? result.result : null,
			remote_id: result.status === 'acked' ? result.result?.$id ?? null : null,
			remote_version: result.status === 'acked' ? result.result?.$version ?? null : null
		})))}::jsonb) AS s(id uuid, attempts int, claimed_at timestamptz, status text,
			replica_id text, observed_id text, observed_version text,
			next_attempt_at timestamptz, error jsonb, result jsonb, remote_id text, remote_version text)`);
		c.cte('settlements', `SELECT a.*, a.status = 'acked' AND o.op <> 'delete'
			AND a.remote_id IS NOT NULL AND r.remote_id IS NOT NULL AND a.remote_id <> r.remote_id
			AND (r.id::text IS DISTINCT FROM a.replica_id OR r.remote_id IS DISTINCT FROM a.observed_id
				OR o.error ->> 'code' = 'identity_conflict') AS identity_conflict
			FROM answers a JOIN sys_outbox o ON o.id = a.id
			LEFT JOIN sys_sync_row r ON r.sync = o.sync AND r.instance = o.instance AND r.record = o.record`);
		capturePiece(c, 'settled', 'sys_outbox', `UPDATE sys_outbox o
			SET status = CASE WHEN s.identity_conflict THEN 'dead' ELSE s.status END,
			error = CASE WHEN s.identity_conflict THEN jsonb_build_object('code', 'identity_conflict', 'message', ${c.p(IDENTITY_CONFLICT)}::text) ELSE s.error END,
			next_attempt_at = coalesce(s.next_attempt_at, o.next_attempt_at),
			acked_at = CASE WHEN s.status = 'acked' THEN ${c.shared('now', now)}::timestamptz ELSE o.acked_at END,
			result = CASE WHEN s.status = 'acked' THEN s.result ELSE o.result END
			FROM settlements s WHERE o.id = s.id AND o.status = 'sending'
			AND o.attempts = s.attempts AND o.claimed_at = s.claimed_at`, { returning: 'o.*' });
		capturePiece(c, 'superseded', 'sys_outbox', `UPDATE sys_outbox older SET status = 'skipped',
			error = '{"message":"A newer change has already been delivered."}'::jsonb FROM settled newer
			WHERE newer.status = 'acked' AND older.sync = newer.sync AND older.instance = newer.instance
			AND older.record = newer.record AND older.seq < newer.seq
			AND older.status IN ('queued', 'sending', 'dead')`, { returning: 'older.key, older.error' });
		c.cte('sends_skipped', `SELECT * FROM ${messagePiece(c, `UPDATE sys_message s SET status = 'skipped', error = discarded.error ->> 'message'
			FROM (SELECT key, error FROM superseded UNION ALL SELECT key, error FROM settled WHERE status = 'skipped') discarded
			WHERE s.meta ->> 'sync_write' = discarded.key AND s.status = 'queued'`, 's.id')}`);
		capturePiece(c, 'unmapped', 'sys_sync_row', `DELETE FROM sys_sync_row r USING settled o, settlements s
			WHERE o.id = s.id AND o.status = 'acked' AND o.op = 'delete'
			AND r.sync = o.sync AND r.instance = o.instance AND r.record = o.record
			AND r.id::text = s.replica_id AND r.remote_id IS NOT DISTINCT FROM s.observed_id
			AND r.remote_version IS NOT DISTINCT FROM s.observed_version
			AND (r.acked_revision IS NULL OR r.acked_revision <= o.record_revision)`);
		const sameIdentity = 'r.id::text IS NOT DISTINCT FROM s.replica_id AND r.remote_id IS NOT DISTINCT FROM s.observed_id';
		capturePiece(c, 'mapped', 'sys_sync_row', `INSERT INTO sys_sync_row (id, sync, instance, partition, remote_id, record, remote_version, cycle, acked_revision)
			SELECT gen_random_uuid(), o.sync, o.instance, '',
			CASE WHEN ${sameIdentity}
				THEN coalesce(s.remote_id, r.remote_id) ELSE r.remote_id END, o.record,
			CASE WHEN ((${sameIdentity}) OR s.remote_id = r.remote_id)
				AND (${replaceVersionSql('s.remote_version', 'r.remote_version',
				`(${sameIdentity}) AND r.remote_version IS NOT DISTINCT FROM s.observed_version`)})
				THEN s.remote_version ELSE r.remote_version END, 0, o.record_revision
			FROM settled o JOIN settlements s USING (id)
			LEFT JOIN sys_sync_row r ON r.sync = o.sync AND r.instance = o.instance AND r.record = o.record
			WHERE o.status = 'acked' AND o.op <> 'delete' AND (r.id IS NOT NULL OR s.replica_id IS NULL)
			AND ((s.result IS NOT NULL AND s.result <> 'null'::jsonb) OR r.id IS NOT NULL)
			ON CONFLICT (sync, instance, record) DO UPDATE SET remote_id = coalesce(excluded.remote_id, sys_sync_row.remote_id),
			remote_version = coalesce(excluded.remote_version, sys_sync_row.remote_version),
			acked_revision = greatest(excluded.acked_revision, sys_sync_row.acked_revision)`);
		c.cte('released', "SELECT 1 FROM settled WHERE status = 'acked' UNION ALL SELECT 1 FROM sends_skipped");
		deliverRun(c, 'released', now);
		enqueueDrain(c, SYNC_DELIVER, "(SELECT min(next_attempt_at) FROM settled WHERE status = 'queued')",
			"EXISTS (SELECT 1 FROM settled WHERE status = 'queued')");
		for (const [index, result] of results.entries()) {
			if (result.row.writer === null || (result.status !== 'acked' && result.status !== 'dead' && result.status !== 'skipped')
				|| ((result.status === 'dead' || result.status === 'skipped') && result.notify === false)) continue;
			const r = result.row;
			noticeInsert(c, `sync_failure_${index}`, [{
				id: `sync:${r.id}`, to: [{ user: r.writer }], via: [],
				title: result.status === 'skipped' ? 'Sync refused a change' : 'Sync needs attention',
				body: result.status === 'acked' ? IDENTITY_CONFLICT : result.message, link: { model: r.model, id: r.record },
				once: `sync:${r.id}`, attachments: []
			}], now, `EXISTS (SELECT 1 FROM settled WHERE id = ${c.p(r.id)}::uuid
				${result.status === 'acked' ? "AND status = 'dead'" : ''})`, m.teams, m.workspace.signup?.policies);
		}
		// Read/ack metadata merges share a snapshot taken after this lock, never the claim's stale map image.
		const answer = yield* nativeCommit(
			(statement) => db.write(statement, { tables: ['sys_outbox', 'sys_sync_row'], mode: 'SHARE ROW EXCLUSIVE' }),
			e.live.publish, c, Schema.Struct({
			...CapturedResult.fields,
			next: Schema.NullOr(Schema.String)
		}), `${next_due(c)}::text AS next`);
		if (answer.next !== null) yield* e.announce(answer.next);
	});
	const refuse = Effect.fn('Syncs.rollbackWrite')(function* (r: Outbox, message: string) {
		const sync = syncs_of(m).get(r.sync);
		if (sync === undefined || !sync.write) return false;
		const observed = new Chain();
		const state = yield* db.value(Schema.Struct({ revision: Schema.NullOr(Schema.Number), current: Schema.Boolean }), {
			text: `SELECT jsonb_build_object('revision', (SELECT revision FROM ${q(r.model)} WHERE id = ${observed.p(r.record)}),
				'current', ${replicaUnchanged(observed, r)})`, params: observed.params
		});
		// A local edit, recovery or newly observed remote checkpoint supersedes this rejected image.
		if (!state.current || (r.op === 'delete' ? state.revision !== null : state.revision !== r.record_revision)) return false;
		const bindings = yield* e.bindings();
		const plan = yield* rollbackPlan(
			m,
			db,
			[{ model: r.model, id: r.record, op: r.op, before: r.acked_revision }],
			bindings
		);
		const actor: EngineActor = {
			kind: 'system',
			run: r.id,
			by: { sync: r.sync, instance: r.instance }
		};
		const [answer] = yield* executeCommit(db, m, catalog_of(m), {
			key: `sync:rollback:${r.id}`,
			digest: canonical([r.id, message]),
			issuedAt: bindings.now,
			now: bindings.now,
			today: bindings.today,
			actor,
			writer: {
				// the holder a sync page writes as (`syncActor`, admin): its rollback's effects run as the same
				starter: { actor, policies: [], admin: true, platform: true },
				actor: actor_ref(actor),
				depth: 0
			},
			writes: plan.writes,
			rate: [],
			runs: [],
			output: null,
			restored: plan.restored,
			rollback: true,
			before: (c) => {
				c.cte(
					'sync_lease',
					`SELECT id FROM sys_outbox WHERE ${claimedBy(c, r)} AND ${GATED} FOR UPDATE`
				);
				c.assert('(SELECT count(*) FROM sync_lease) = 1', 'conflict');
				c.assert(replicaUnchanged(c, r), 'conflict');
				c.assert(`EXISTS (SELECT 1 FROM sys_integration WHERE id = ${c.p(r.instance)}
					AND active AND integration = ${c.p(sync.definition)})`, 'conflict');
				c.assert(r.op === 'delete'
					? `NOT EXISTS (SELECT 1 FROM ${q(r.model)} WHERE id = ${c.p(r.record)})`
					: `EXISTS (SELECT 1 FROM ${q(r.model)} WHERE id = ${c.p(r.record)} AND revision = ${c.p(r.record_revision)})`, 'conflict');
			},
			pieces: (c) => {
				capturePiece(c,
					'sync_failed',
					'sys_outbox',
					`UPDATE sys_outbox SET status = CASE WHEN id = ${c.p(r.id)} THEN 'failed' ELSE 'skipped' END,
					error = ${c.p({ message })}::jsonb WHERE sync = ${c.p(r.sync)} AND instance = ${c.p(r.instance)} AND record = ${c.p(r.record)}
					AND status IN ('sending', 'queued') AND ${GATED} AND EXISTS (SELECT 1 FROM sync_lease)`
				);
				c.cte(
					'sends_skipped',
					`SELECT * FROM ${messagePiece(c, `UPDATE sys_message SET status = 'skipped', error = ${c.p(message)}
					WHERE meta ->> 'sync_write' = ${c.p(r.key)} AND status = 'queued' AND EXISTS (SELECT 1 FROM sync_failed)`, 'sys_message.id')}`
				);
				deliverRun(c, 'sends_skipped', bindings.now);
				// Peer sends keep FIFO ownership; their later acknowledgement supplies the recovery's remote id/version.
				syncOutboxPiece(m, c, bindings.now, new Set(Object.keys(m.models)), actor, 'allp', { preserve_local: true });
				if (r.writer !== null)
					noticeInsert(
						c,
						'sync_failure',
						[
							{
								id: `sync:${r.id}`,
								to: [{ user: r.writer }],
								via: [],
								title: 'Sync refused a change',
								body: message,
								link: { model: r.model, id: r.record },
								once: `sync:${r.id}`,
								attachments: []
							}
						],
						bindings.now,
						GATED,
						m.teams,
						m.workspace.signup?.policies
					);
			}
		}, { tables: [r.model, 'sys_integration', 'sys_outbox', 'sys_sync_row'].sort(), mode: 'SHARE ROW EXCLUSIVE' });
		if (answer === undefined)
			return yield* Effect.fail(BoltError.make('bad_answer', 'commit', 'The sync rollback returned no answer.'));
		if (answer.outcome?.kind === 'conflict') return false;
		e.live.publish(answer.captured);
		if (answer.next_due !== null) yield* e.announce(answer.next_due);
		return true;
	});
	const deliverBatch = Effect.fn('Syncs.deliverBatch')(function* (rows: readonly Outbox[]) {
		const gate = yield* Semaphore.make(1);
		const owned = new Map(rows.map((row) => [row.id, row]));
		const pending = new Map<string, DeliverySettlement>();
		const renew = gate.withPermit(Effect.uninterruptible(Effect.gen(function* () {
			if (owned.size === 0) return;
			const c = new Chain();
			const tokens = yield* db.returning(ClaimToken, {
				text: renewClaims('sync', c, [...owned.values()].map(({ id, attempts, claimed_at }) => ({ id, attempts, claimed_at })), iso(yield* Clock.currentTimeMillis)),
				params: c.params
			});
			const renewed = new Map(tokens.map((token) => [token.id, token]));
			for (const [id, row] of owned) {
				const token = renewed.get(id);
				if (token === undefined) owned.delete(id);
				else owned.set(id, { ...row, ...token });
			}
		})));
		const flush = gate.withPermit(Effect.uninterruptible(Effect.gen(function* () {
			const results = [...pending.values()].flatMap((result) => {
				const row = owned.get(result.row.id);
				return row === undefined ? [] : [{ ...result, row }];
			});
			yield* settleBatch(results);
			for (const id of pending.keys()) owned.delete(id);
			pending.clear();
		})));
		const admitted = (input: Outbox, definition?: string) => gate.withPermit(Effect.gen(function* () {
			const r = owned.get(input.id);
			if (r === undefined) return false;
			const c = new Chain(), now = iso(yield* Clock.currentTimeMillis);
			const state = yield* db.value(Schema.Struct({ active: Schema.Boolean, connected: Schema.Boolean, superseded: Schema.Boolean }), {
				text: `SELECT jsonb_build_object('active', EXISTS (SELECT 1 FROM sys_outbox WHERE ${claimedBy(c, r)} AND claimed_at >= ${c.p(now)}::timestamptz - ${leaseInterval('sync')}),
				'connected', ${definition === undefined ? 'true' : `EXISTS (SELECT 1 FROM sys_integration WHERE id = ${c.p(r.instance)} AND active AND integration = ${c.p(definition)})`},
				'superseded', EXISTS (SELECT 1 FROM sys_outbox newer JOIN sys_outbox held ON held.id = ${c.p(r.id)}
				WHERE newer.sync = held.sync AND newer.instance = held.instance AND newer.record = held.record
				AND newer.seq > held.seq AND newer.status = 'acked'))`,
				params: c.params
			});
			if (!state.active) { owned.delete(r.id); return false; }
			if (!state.connected) return false;
			if (!state.superseded) return true;
			pending.set(r.id, { row: r, status: 'skipped', message: 'A newer change has already been delivered.', notify: false });
			return false;
		}));
		const attempt = Effect.fn('Syncs.write')(function* (claimed: Outbox) {
			const r = owned.get(claimed.id);
			if (r === undefined || !(yield* admitted(r))) return;
			const s = syncs_of(m).get(r.sync);
			if (s === undefined || !s.write) {
				pending.set(r.id, { row: r, status: 'skipped', message: 'This sync is no longer declared.' });
				return;
			}
			const [inst] = yield* instancesOf(m, db, { ids: [r.instance] });
			if (inst === undefined) {
				pending.set(r.id, { row: r, status: 'skipped', message: 'The integration instance was removed.' });
				return;
			}
			if (inst.integration !== s.definition || r.model !== s.model) {
				pending.set(r.id, { row: r, status: 'skipped', message: 'The sync integration or model changed.' });
				return;
			}
			if (!inst.active) {
				pending.set(r.id, { row: r, status: 'queued', at: iso(yield* Clock.currentTimeMillis), message: 'The integration instance is inactive.' });
				return;
			}
			const result = yield* integrationBody(e, {
				id: `${r.id}:${r.attempts}`, kind: 'syncWrite', target: s.target,
				actor: syncActor(s, r.instance, r.id), instance: r.instance, key: r.key,
				configuration: inst.configuration,
				fence: admitted(r, s.definition).pipe(Effect.flatMap((active) => active ? Effect.void
					: Effect.fail(BoltError.make('fenced', 'admission', 'This delivery claim has expired.')))),
				args: [{ op: r.delivery_op, instance: r.instance, ...syncChange(m, r.model, r.image, r.changed),
					$id: r.remote_id, $version: r.remote_version }, { $ctx: true }]
			}).pipe(Effect.flatMap((value) => Schema.decodeUnknownEffect(Ack)(value).pipe(
				Effect.mapError((error) => BoltError.make('bad_answer', 'guest', `${s.name}: write returns { $id?, $version? } or null.`, error))
			)), Effect.result);
			if (result._tag === 'Success') {
				pending.set(r.id, { row: r, status: 'acked', result: result.success });
				return;
			}
			if (!(yield* admitted(r, s.definition))) return;
			const error = result.failure, sql = inst.definition.driver === 'sqlserver';
			// Rejected initialization/recovery and database writes preserve the existing local commitment.
			if (((sql || r.preserve_local) && !is_transient(error)) || (!sql && is_transient(error) && r.attempts >= ATTEMPTS)) {
				pending.set(r.id, { row: r, status: 'dead', message: error.message });
				return;
			}
			if (!is_transient(error)) {
				// Earlier acknowledgements must be committed before a refusal plans its rollback.
				yield* flush;
				yield* gate.withPermit(Effect.gen(function* () {
					const current = owned.get(r.id);
					if (current === undefined) return;
					if (yield* refuse(current, error.message)) owned.delete(r.id);
					else pending.set(r.id, { row: current, status: 'dead', message: error.message });
				}));
				return;
			}
			const now = yield* Clock.currentTimeMillis;
			const delay = retryDelay(sql ? 1 : r.attempts, BACKOFF, 3_600_000, 0.9 + Math.random() * 0.2);
			pending.set(r.id, { row: r, status: 'queued',
				at: iso(Math.max(now + delay, retryAfterOf(db, r.instance))), message: error.message });
		});
		yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
			yield* renew;
			// A paced connection can take longer than one lease; keep its unstarted and completed claims owned together.
			const heartbeat = renew.pipe(Effect.repeat(Schedule.spaced(LEASE_MS.sync / 3)), Effect.delay(LEASE_MS.sync / 3));
			const result = yield* restore(Effect.raceFirst(Effect.forEach(rows, attempt, { discard: true }), heartbeat)).pipe(Effect.exit);
			// External successes still settle when a later item fails or the generation interrupts the batch.
			const saved = yield* flush.pipe(Effect.exit);
			if (Exit.isFailure(result)) return yield* Effect.failCause(Exit.isFailure(saved) ? Cause.combine(result.cause, saved.cause) : result.cause);
			if (Exit.isFailure(saved)) return yield* Effect.failCause(saved.cause);
		}));
	});
	return {
		deliver: Effect.fn('Syncs.deliver')(function* () {
			const skipped = new Chain();
			capturePiece(skipped, 'other_epoch', 'sys_outbox', `UPDATE sys_outbox SET status = 'skipped',
				error = '{"message":"Queued in another environment epoch"}'::jsonb
				WHERE status IN ('queued', 'sending') AND coalesce(epoch, '') <> ${skipped.p(e.epoch)}`);
			yield* nativeCommit(db.write, e.live.publish, skipped, CapturedResult);
			let delivered = 0,
				guarded = false;
			for (let left = 1000; left > 0;) {
				const now = iso(yield* Clock.currentTimeMillis);
				const claims = new Chain(), at = claims.p(now), definitions = claims.p(databases);
				const missing = `NOT EXISTS (SELECT 1 FROM sys_sync_row r
					WHERE r.sync = q.sync AND r.instance = q.instance AND r.record = q.record)`;
				capturePiece(claims, 'claimed', 'sys_outbox', claimSql('sync', {
						at,
						set: `delivery_op = coalesce(q.delivery_op, CASE WHEN q.op = 'delete' THEN 'delete'
							WHEN ${missing} THEN 'create' ELSE 'update' END),
							preserve_local = q.preserve_local OR (q.op <> 'create' AND ${missing})
								OR (q.op = 'create' AND NOT (${missing}))`,
						join: 'JOIN sys_integration i ON i.id = q.instance AND i.active',
						where: `${ready(definitions)}
							AND NOT EXISTS (SELECT 1 FROM sys_outbox p WHERE p.sync = q.sync AND p.instance = q.instance AND p.record = q.record
								AND p.seq < q.seq AND p.status IN ('queued', 'sending'))
							AND NOT EXISTS (SELECT 1 FROM sys_outbox p WHERE p.sync = q.sync AND p.instance = q.instance AND p.record = q.record
								AND p.id <> q.id AND p.status = 'sending' AND ${leaseExpiry('sync', 'p')} >= ${at}::timestamptz)`,
						order: 'q.seq',
						limit: Math.min(DELIVERY_BATCH, left)
					}), { returning: 'q.*' });
				const { rows } = yield* nativeCommit(db.write, e.live.publish, claims,
					Schema.Struct({ ...CapturedResult.fields, rows: Schema.Array(Outbox) }),
					`(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.seq), '[]'::jsonb) FROM (
				SELECT o.seq, o.id::text, o.sync, o.instance::text, o.model, o.record, o.op, o.delivery_op, o.record_revision, o.changed, o.image,
					o.writer::text, o.key, o.attempts, o.preserve_local, o.claimed_at::text, r.id::text AS replica_id, r.remote_id, r.remote_version, r.acked_revision
				FROM claimed o LEFT JOIN sys_sync_row r ON r.sync = o.sync AND r.instance = o.instance AND r.record = o.record) row) AS rows`);
				if (rows.length === 0) break;
				left -= rows.length;
				if (!guarded) {
					yield* schedule(leaseUntil(now, LEASE_MS.sync));
					guarded = true;
				}
				yield* Effect.forEach(
					[...Map.groupBy(rows, (row) => row.instance)],
					([, batch]) => deliverBatch(batch),
					{ concurrency: DELIVERY_CONNECTIONS, discard: true }
				);
				delivered += rows.length;
			}
			const [next] = yield* db.rows(Schema.Struct({ at: Schema.NullOr(Schema.String) }), {
				text: `SELECT min(greatest(CASE WHEN o.status = 'sending' THEN ${leaseExpiry('sync', 'o')} ELSE o.next_attempt_at END,
			(SELECT max(${leaseExpiry('sync', 'p')}) FROM sys_outbox p WHERE p.sync = o.sync AND p.instance = o.instance
			AND p.record = o.record AND p.id <> o.id AND p.status = 'sending')))::text AS at
			FROM sys_outbox o JOIN sys_integration i ON i.id = o.instance AND i.active WHERE ${ready('$1')} AND o.status IN ('queued', 'sending')
			AND NOT EXISTS (SELECT 1 FROM sys_outbox p WHERE p.sync = o.sync AND p.instance = o.instance AND p.record = o.record AND p.seq < o.seq AND p.status IN ('queued', 'sending'))`,
				params: [databases]
			});
			if (next?.at !== null && next?.at !== undefined) yield* schedule(next.at);
			return { delivered };
		})()
	};
}

const StateRow = Schema.Struct({
	record: Schema.String,
	sync: Schema.String,
	status: Schema.String,
	error: Schema.NullOr(Schema.Struct({ message: Schema.String }))
});
export const syncState = Effect.fn('Syncs.state')(function* (
	m: EngineManifest,
	db: Pick<TenantDbShape, 'rows'>,
	model: string,
	ids: readonly string[]
) {
	const names = [...syncs_of(m).values()]
		.filter((s) => s.model === model && s.write)
		.map((s) => s.name);
	if (names.length === 0) return undefined;
	const out = new Map<
		string,
		Record<string, { status: 'pending' | 'ok' | 'failed'; message?: string }>
	>(ids.map((id) => [id, {}]));
	if (ids.length === 0) return out;
	const rows = yield* db.rows(StateRow, {
		text: `SELECT DISTINCT ON (sync, record) sync, record, status, error FROM (
			SELECT DISTINCT ON (sync, record, instance) sync, record, instance, status, error, seq FROM sys_outbox
			WHERE sync IN (SELECT jsonb_array_elements_text($1::jsonb)) AND record IN (SELECT jsonb_array_elements_text($2::jsonb))
			ORDER BY sync, record, instance, seq DESC
		) latest ORDER BY sync, record,
			CASE WHEN status = 'acked' THEN 2 WHEN status IN ('queued', 'sending') THEN 1 ELSE 0 END,
			seq DESC, instance`,
		params: [JSON.stringify(names), JSON.stringify(ids)]
	});
	for (const r of rows) {
		const row = out.get(r.record),
			name = syncs_of(m).get(r.sync)?.sync;
		if (row !== undefined && name !== undefined)
			row[name] = {
				status:
					r.status === 'acked'
						? 'ok'
						: r.status === 'queued' || r.status === 'sending'
							? 'pending'
							: 'failed',
				...(r.error === null ? {} : { message: r.error.message })
			};
	}
	return out;
});
