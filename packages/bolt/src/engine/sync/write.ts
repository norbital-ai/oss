import { Clock, Effect, Schema } from 'effect';
import { canonical } from '@norbital-ai/store';
import type { EngineActor } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { catalogOf } from '../access/pred.ts';
import { BoltError } from '../../protocol/errors.ts';
import { isTransient } from '../errors.ts';
import { Chain, GATED, noticeInsert } from '../write/sql.ts';
import { actorId, actorRef, executeCommit } from '../write/commit.ts';
import { rollbackPlan } from '../approvals/rollback.ts';
import { enqueue } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { instancesOf, integrationBody, retryAfterOf } from '../integrations/instances.ts';
import { syncActor, syncsOf, type SyncEngine } from './index.ts';
import { deliverRun } from '../integrations/outbound.ts';

export const SYNC_DELIVER = 'sync.deliver';
const EPOCH = "coalesce((SELECT value FROM sys_config WHERE key = 'integrations.epoch'), '')";
const ATTEMPTS = 8;
const queues = new WeakMap<Chain, number>();
const BACKOFF = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];
/** Retries keep the payload and key; only an unattempted queued row may coalesce. */
export const retryDelay = (attempt: number, jitter: number): number =>
	(BACKOFF[Math.min(Math.max(0, attempt - 1), BACKOFF.length - 1)] ?? 3_600_000) *
	(0.9 + jitter * 0.2);

/** The transactional outbox: one entry per sync, instance and row, with the committed image frozen for retries. */
export function syncOutboxPiece(
	m: EngineManifest,
	c: Chain,
	now: string,
	written: ReadonlySet<string>,
	actor: EngineActor,
	source = 'allp'
): void {
	const index = queues.get(c) ?? 0;
	queues.set(c, index + 1);
	const syncs = [...syncsOf(m).values()].filter(
		(s) =>
			s.write &&
			written.has(s.model) &&
			!(actor.kind === 'system' && 'sync' in actor.by && actor.by.sync === s.name)
	);
	const selects = syncs.map((s) => {
		const image = 'coalesce(x.n, x.o)';
		const instance = s.fk === undefined ? c.p(s.connection ?? '') : `${image} ->> ${c.p(s.fk)}`;
		return `SELECT ${c.p(s.name)}::text AS sync, ${instance}::text AS instance, x.c AS model, x.id AS record,
			x.op, x.revision AS record_revision, ${image} AS image,
			(SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(${image}) k
			 WHERE k NOT IN ('id', 'revision', 'created_at', 'created_by', 'updated_at', 'updated_by')
			 AND (x.op <> 'update' OR x.o -> k IS DISTINCT FROM x.n -> k)) AS changed
		FROM ${source} x JOIN sys_integration i ON i.id = ${instance} AND i.integration = ${c.p(s.definition)}
		WHERE x.c = ${c.p(s.model)} AND x.cause IN ('direct', 'cascade') AND ${GATED}`;
	});
	if (selects.length > 0) {
		const inserted = c.cte(
			`sync_queued${index}`,
			`INSERT INTO sys_outbox
			(id, sync, instance, model, record, op, record_revision, changed, image, writer, key, status, attempts, next_attempt_at, epoch, at)
			SELECT gen_random_uuid(), s.sync, s.instance, s.model, s.record, s.op, s.record_revision, s.changed, s.image,
			${c.p(actorId(actor))}, s.sync || ':' || s.instance || ':' || s.record || ':' || s.record_revision,
			'queued', 0, ${c.p(now)}::timestamptz, ${EPOCH}, ${c.p(now)}::timestamptz FROM (${selects.join(' UNION ALL ')}) s
			ON CONFLICT (sync, instance, record) WHERE status = 'queued' AND attempts = 0 DO UPDATE SET
				op = CASE WHEN sys_outbox.op = 'create' AND excluded.op <> 'delete' THEN 'create' ELSE excluded.op END,
				record_revision = excluded.record_revision, image = excluded.image, writer = excluded.writer, key = excluded.key,
				changed = (SELECT jsonb_agg(DISTINCT f) FROM jsonb_array_elements(sys_outbox.changed || excluded.changed) f)
			RETURNING id`
		);
		enqueue(c, [{ automation: SYNC_DELIVER, input: {}, dueAt: now, cause: 'schedule', depth: 0 }], {
			when: `EXISTS (SELECT 1 FROM ${inserted})`
		});
	}
	if (written.has('sys_integration'))
		enqueue(c, [{ automation: SYNC_DELIVER, input: {}, dueAt: now, cause: 'schedule', depth: 0 }], {
			when: `EXISTS (SELECT 1 FROM ${source} x WHERE x.c = 'sys_integration' AND x.n ->> 'active' = 'true' AND x.o ->> 'active' IS DISTINCT FROM 'true')`
		});
}

const Outbox = Schema.Struct({
	id: Schema.String,
	sync: Schema.String,
	instance: Schema.String,
	model: Schema.String,
	record: Schema.String,
	op: Schema.Literals(['create', 'update', 'delete']),
	record_revision: Schema.Number,
	changed: Schema.Array(Schema.String),
	image: Schema.Record(Schema.String, Schema.Json),
	writer: Schema.NullOr(Schema.String),
	key: Schema.String,
	attempts: Schema.Number,
	claimed_at: Schema.String,
	remote_id: Schema.NullOr(Schema.String),
	remote_version: Schema.NullOr(Schema.String),
	acked_revision: Schema.NullOr(Schema.Number)
});
type Outbox = typeof Outbox.Type;
const Ack = Schema.NullOr(
	Schema.Struct({
		$id: Schema.optionalKey(Schema.String),
		$version: Schema.optionalKey(Schema.String)
	})
);
const lease = (c: Chain, r: Outbox) =>
	`id = ${c.p(r.id)} AND status = 'sending' AND attempts = ${c.p(r.attempts)} AND claimed_at = ${c.p(r.claimed_at)}::timestamptz`;

export function makeDeliver(e: SyncEngine) {
	const { db, manifest: m } = e;
	const changed = (r: Outbox) => e.live.syncChanged(r.model, [r.record]);
	const schedule = Effect.fn('Syncs.scheduleWrite')(function* (at: string) {
		const c = new Chain();
		enqueue(
			c,
			[
				{
					automation: SYNC_DELIVER,
					input: {},
					dueAt: at,
					key: `${SYNC_DELIVER}@${at}`,
					cause: 'schedule',
					depth: 0
				}
			],
			{ conflict: 'keep' }
		);
		yield* db.write(c.sql('NULL AS outcome'));
		yield* e.announce(at);
	});
	const settle = Effect.fn('Syncs.settle')(function* (
		r: Outbox,
		status: 'failed' | 'dead' | 'skipped',
		message: string
	) {
		const now = iso(yield* Clock.currentTimeMillis),
			c = new Chain();
		const finished = c.cte(
			'settled',
			`UPDATE sys_outbox SET status = ${c.p(status)}, error = ${c.p({ message })}::jsonb WHERE ${lease(c, r)} RETURNING id`
		);
		if (status !== 'dead') {
			c.cte(
				'sends_skipped',
				`UPDATE sys_message SET status = 'skipped', error = ${c.p(message)}
				WHERE meta ->> 'sync_write' = ${c.p(r.key)} AND status = 'queued' AND EXISTS (SELECT 1 FROM ${finished}) RETURNING id`
			);
			deliverRun(c, 'sends_skipped', now);
		}
		if (r.writer !== null)
			noticeInsert(
				c,
				'sync_failure',
				[
					{
						id: `sync:${r.id}`,
						to: [{ user: r.writer }],
						via: [],
						title: status === 'dead' ? 'Sync needs attention' : 'Sync refused a change',
						body: message,
						link: { model: r.model, id: r.record },
						once: `sync:${r.id}`,
						attachments: []
					}
				],
				now,
				`EXISTS (SELECT 1 FROM ${finished})`,
				m.teams,
				m.workspace.signup?.policies
			);
		yield* db.write(c.sql('NULL AS outcome'));
		if (status !== 'dead') yield* e.announce(now);
		changed(r);
	});
	const refuse = Effect.fn('Syncs.rollbackWrite')(function* (r: Outbox, message: string) {
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
		const [answer] = yield* executeCommit(db, m, catalogOf(m), {
			key: `sync:rollback:${r.id}`,
			digest: canonical([r.id, message]),
			issuedAt: bindings.now,
			now: bindings.now,
			today: bindings.today,
			actor,
			writer: {
				starter: { actor, policies: [], admin: false, platform: true },
				actor: actorRef(actor),
				depth: 0
			},
			writes: plan.writes,
			owned: [],
			rate: [],
			runs: [],
			notices: [],
			output: null,
			restored: plan.restored,
			rollback: true,
			before: (c) => {
				c.cte(
					'sync_lease',
					`SELECT id FROM sys_outbox WHERE ${lease(c, r)} AND ${GATED} FOR UPDATE`
				);
				c.assert('(SELECT count(*) FROM sync_lease) = 1', 'conflict');
			},
			pieces: (c) => {
				c.cte(
					'sync_failed',
					`UPDATE sys_outbox SET status = CASE WHEN id = ${c.p(r.id)} THEN 'failed' ELSE 'skipped' END,
					error = ${c.p({ message })}::jsonb WHERE sync = ${c.p(r.sync)} AND instance = ${c.p(r.instance)} AND record = ${c.p(r.record)}
					AND status IN ('sending', 'queued') AND ${GATED} RETURNING id`
				);
				c.cte(
					'sends_skipped',
					`UPDATE sys_message SET status = 'skipped', error = ${c.p(message)}
					WHERE meta ->> 'sync_write' = ${c.p(r.key)} AND status = 'queued' AND EXISTS (SELECT 1 FROM sync_failed) RETURNING id`
				);
				deliverRun(c, 'sends_skipped', bindings.now);
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
		});
		if (answer !== undefined) {
			if (answer.outcome?.kind === 'conflict')
				return yield* Effect.fail(
					BoltError.make('conflict', 'commit', 'The record changed while sync rolled it back.')
				);
			e.live.publish(answer.captured);
			if (answer.next_due !== null) yield* e.announce(answer.next_due);
		}
		changed(r);
	});
	const attempt = Effect.fn('Syncs.write')(function* (r: Outbox) {
		const s = syncsOf(m).get(r.sync);
		if (s === undefined || !s.write)
			return yield* settle(r, 'skipped', 'This sync is no longer declared.');
		const [inst] = yield* instancesOf(m, db, { ids: [r.instance] });
		if (inst === undefined)
			return yield* settle(r, 'skipped', 'The integration instance was removed.');
		const result = yield* integrationBody(e, {
			id: `${r.id}:${r.attempts}`,
			kind: 'syncWrite',
			target: s.target,
			actor: syncActor(s, r.instance, r.id),
			instance: r.instance,
			key: r.key,
			configuration: inst.configuration,
			args: [
				{
					op: r.op,
					row: r.image,
					changed: r.changed,
					$id: r.remote_id,
					$version: r.remote_version
				},
				{ $ctx: true }
			]
		}).pipe(
			Effect.flatMap((value) =>
				Schema.decodeUnknownEffect(Ack)(value).pipe(
					Effect.mapError((error) =>
						BoltError.make(
							'badAnswer',
							'guest',
							`${s.name}: write returns { $id?, $version? } or null.`,
							error
						)
					)
				)
			),
			Effect.result
		);
		if (result._tag === 'Failure') {
			const error = result.failure;
			if (!isTransient(error)) return yield* refuse(r, error.message);
			if (r.attempts >= ATTEMPTS) return yield* settle(r, 'dead', error.message);
			const now = yield* Clock.currentTimeMillis;
			const at = iso(
					Math.max(now + retryDelay(r.attempts, Math.random()), retryAfterOf(db, r.instance))
				),
				c = new Chain();
			c.cte(
				'retry',
				`UPDATE sys_outbox SET status = 'queued', next_attempt_at = ${c.p(at)}::timestamptz,
				error = ${c.p({ message: error.message })}::jsonb WHERE ${lease(c, r)} RETURNING id`
			);
			yield* db.write(c.sql('NULL AS outcome'));
			yield* schedule(at);
			changed(r);
			return;
		}
		const now = iso(yield* Clock.currentTimeMillis),
			c = new Chain();
		c.cte(
			'acked',
			`UPDATE sys_outbox SET status = 'acked', acked_at = ${c.p(now)}::timestamptz,
			result = ${c.p(result.success)}::jsonb, error = NULL WHERE ${lease(c, r)} RETURNING id`
		);
		const remote = result.success?.$id ?? r.remote_id;
		if (r.op === 'delete')
			c.cte(
				'unmapped',
				`DELETE FROM sys_sync_row WHERE sync = ${c.p(r.sync)} AND instance = ${c.p(r.instance)} AND record = ${c.p(r.record)} AND EXISTS (SELECT 1 FROM acked)`
			);
		else if (remote !== null)
			c.cte(
				'mapped',
				`INSERT INTO sys_sync_row (id, sync, instance, partition, remote_id, record, remote_version, cycle, acked_revision)
			SELECT gen_random_uuid(), ${c.p(r.sync)}, ${c.p(r.instance)}, '', ${c.p(remote)}, ${c.p(r.record)},
			${c.p(result.success?.$version ?? r.remote_version)}, 0, ${c.p(r.record_revision)} WHERE EXISTS (SELECT 1 FROM acked)
			ON CONFLICT (sync, instance, record) DO UPDATE SET remote_id = excluded.remote_id,
			remote_version = excluded.remote_version, acked_revision = excluded.acked_revision`
			);
		deliverRun(c, 'acked', now);
		yield* db.write(c.sql('NULL AS outcome'));
		yield* e.announce(now);
		changed(r);
	});
	return {
		deliver: Effect.fn('Syncs.deliver')(function* () {
			yield* db.write({
				text: "UPDATE sys_outbox SET status = 'skipped', error = '{\"message\":\"Queued in another environment epoch\"}'::jsonb WHERE status IN ('queued', 'sending') AND coalesce(epoch, '') <> $1",
				params: [e.epoch]
			});
			let delivered = 0,
				guarded = false;
			for (let i = 0; i < 1000; i++) {
				const now = iso(yield* Clock.currentTimeMillis);
				const rows = yield* db.returning(Outbox, {
					text: `WITH candidate AS (
				SELECT o.id FROM sys_outbox o JOIN sys_integration i ON i.id = o.instance AND i.active
				WHERE ((o.status = 'queued' AND o.next_attempt_at <= $1::timestamptz) OR (o.status = 'sending' AND o.claimed_at < $1::timestamptz - interval '5 minutes'))
				AND NOT EXISTS (SELECT 1 FROM sys_outbox p WHERE p.sync = o.sync AND p.instance = o.instance AND p.record = o.record
				 AND p.seq < o.seq AND p.status IN ('queued', 'sending', 'dead'))
				ORDER BY o.seq LIMIT 1 FOR UPDATE OF o SKIP LOCKED), claimed AS (
				UPDATE sys_outbox o SET status = 'sending', attempts = o.attempts + 1, claimed_at = $1::timestamptz
				FROM candidate WHERE o.id = candidate.id RETURNING o.*)
				SELECT o.id::text, o.sync, o.instance::text, o.model, o.record, o.op, o.record_revision, o.changed, o.image,
				o.writer::text, o.key, o.attempts, o.claimed_at::text, r.remote_id, r.remote_version, r.acked_revision
				FROM claimed o LEFT JOIN sys_sync_row r ON r.sync = o.sync AND r.instance = o.instance AND r.record = o.record`,
					params: [now]
				});
				const r = rows[0];
				if (r === undefined) break;
				if (!guarded) {
					yield* schedule(iso(Date.parse(now) + 5 * 60_000));
					guarded = true;
				}
				yield* attempt(r);
				delivered++;
			}
			const [next] = yield* db.rows(Schema.Struct({ at: Schema.NullOr(Schema.String) }), {
				text: `SELECT min(CASE WHEN o.status = 'sending' THEN o.claimed_at + interval '5 minutes' ELSE o.next_attempt_at END)::text AS at
			FROM sys_outbox o JOIN sys_integration i ON i.id = o.instance AND i.active WHERE o.status IN ('queued', 'sending')
			AND NOT EXISTS (SELECT 1 FROM sys_outbox p WHERE p.sync = o.sync AND p.instance = o.instance AND p.record = o.record AND p.seq < o.seq AND p.status IN ('queued', 'sending', 'dead'))`,
				params: []
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
	const names = [...syncsOf(m).values()]
		.filter((s) => s.model === model && s.write)
		.map((s) => s.name);
	if (names.length === 0) return undefined;
	const out = new Map<
		string,
		Record<string, { status: 'pending' | 'ok' | 'failed'; message?: string }>
	>(ids.map((id) => [id, {}]));
	if (ids.length === 0) return out;
	const rows = yield* db.rows(StateRow, {
		text: `SELECT DISTINCT ON (sync, record) sync, record, status, error FROM sys_outbox
		WHERE sync IN (SELECT jsonb_array_elements_text($1::jsonb)) AND record IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY sync, record, seq DESC`,
		params: [JSON.stringify(names), JSON.stringify(ids)]
	});
	for (const r of rows) {
		const row = out.get(r.record),
			name = syncsOf(m).get(r.sync)?.sync;
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
