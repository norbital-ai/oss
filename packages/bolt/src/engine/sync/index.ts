import { uuid } from '../port.ts';
// Syncs (spec §3): a model's rows exchanged with another system through an integration instance. A remote sync's
// author writes at most two guest bodies — `read` (their rows → the model's) and `write` (one committed change → a call
// to them) — and the engine owns the rest in the tenant's own Postgres: the read run (`read.ts`: one act per page with
// its cursor, id map and `$version` guard in the same statement), the webhook inbox (`hint.ts`: verified deliveries
// stored once, then a debounced read), and the outbox (`write.ts`: queued in the statement that wrote the record,
// delivered FIFO per record with retries, dead letter, rollback on refusal). File syncs are `file.ts`'s.
//
// Every active connection of the integration reads independently and receives committed changes. The id map and
// outbox carry the connection per replica; an inbound change fans out to peers. Its own connection receives only a
// correction when an older uncertain outbound delivery could overwrite that inbound image.
import { Clock, Context, Crypto, Effect, Layer, Schema } from 'effect';
import { bindingsAt } from '../query/reader.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { Drivers } from '../ports.ts';
import {
	Activation,
	Guest,
	Identity,
	Live,
	Manifest,
	Reads,
	RunHandlers,
	type RunHandler,
	Wake,
	Writes,
	type GuestShape,
	type IdentityShape,
	type LiveShape,
	type ReadsShape,
	type WritesShape
} from '../services.ts';
import type { EngineManifest } from '../manifest.ts';
import type { SyncEntry } from '../../decl/model.ts';
import type { Json } from '../../decl/values.ts';
import type { WebhookDelivery } from '../../decl/runtime/integration.ts';
import type { Bindings, CronEntry, EngineActor } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { duration, iso } from '../runs/time.ts';
import { instancesOf, integrationBody, writeStatus } from '../integrations/instances.ts';
import { makeRead } from './read.ts';
import { makeDeliver } from './write.ts';
import { SYNC_DELIVER } from './outbox.ts';
import { Chain } from '../write/sql.ts';
import { enqueueDrain } from '../runs/queue.ts';
import { makeHint } from './hint.ts';
import { failedBackfills, makeBackfill, replayBackfills, SYNC_BACKFILL } from './backfill.ts';

/** One remote sync of a model, as the engine runs it. */
export type RemoteSync = {
	/** `'<model>.sync.<sync>'`: its read run, the actor's `by.sync` and the state tables' `sync`. */
	readonly name: string;
	readonly model: string;
	readonly sync: string;
	/** The guest target of its bodies, `'<model>.<sync>'`. */
	readonly target: string;
	/** The integration definition it goes through (`with`). */
	readonly definition: string;
	readonly read: boolean;
	readonly write: boolean;
	/** How often its read runs (`every`, default `'15min'`). */
	readonly every: string;
	/** The configuration field whose values partition its read (one cursor each). */
	readonly partitions: string | undefined;
	readonly entry: SyncEntry;
};
export const EVERY = '15min';
const memo = new WeakMap<EngineManifest, ReadonlyMap<string, RemoteSync>>();
/** Every remote sync by its run name `'<model>.sync.<sync>'`. */
export const syncs_of = (m: EngineManifest): ReadonlyMap<string, RemoteSync> => {
	let x = memo.get(m);
	if (x === undefined) {
		x = new Map(
			Object.entries(m.exposures).flatMap(([model, c]) =>
				Object.entries(c.syncs ?? {}).flatMap(([sync, entry]): [string, RemoteSync][] => {
					if (entry.with === 'file') return [];
					const name = `${model}.sync.${sync}`;
					return [
						[
							name,
							{
								name,
								model,
								sync,
								target: `${model}.${sync}`,
								definition: entry.with,
								read: entry.read === true,
								write: entry.write === true,
								every: entry.every ?? EVERY,
								partitions: entry.partitions,
								entry
							}
						]
					];
				})
			)
		);
		memo.set(m, x);
	}
	return x;
};
const DIVISORS = { minute: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30], hour: [1, 2, 3, 4, 6, 8, 12] };
/**
 * `every` as the host's clock fires it: a cron. An interval that does not divide the hour or the day runs at the
 * largest one that does below it (`'7min'` every 6 minutes, `'5h'` every 4 hours); whole days run from midnight.
 */
export const everyCron = (every: string): string => {
	const minutes = Math.max(1, Math.floor(duration(every) / 60_000));
	if (minutes < 60) {
		const n = DIVISORS.minute.filter((d) => d <= minutes).at(-1) ?? 1;
		return n === 1 ? '* * * * *' : `*/${n} * * * *`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const n = DIVISORS.hour.filter((d) => d <= hours).at(-1) ?? 1;
		return n === 1 ? '0 * * * *' : `0 */${n} * * *`;
	}
	const days = Math.min(31, Math.floor(hours / 24));
	return days === 1 ? '0 0 * * *' : `0 0 */${days} * *`;
};
/** H6: each remote read's periodic run, fired by the host's clock in the workspace's zone as an automation's cron is. */
export const syncTriggers = (m: EngineManifest): readonly CronEntry[] =>
	[...syncs_of(m).values()]
		.filter((s) => s.read)
		.map((s) => ({ id: s.name, cron: everyCron(s.every), zone: m.workspace.tz }));

/** What a sync writes and reads as: the system actor of that sync on that instance (never sent back through it). */
export const syncActor = (s: RemoteSync, instance: string, run: string): EngineActor => ({
	kind: 'system',
	run,
	by: { sync: s.name, instance }
});

export { SyncHealth } from './health-schema.ts';
import { SyncHealth, SyncDeadLetter } from './health-schema.ts';
export type SyncsShape = {
	/** A pushing driver's `invalidate` of sync `'<model>.<sync>'`: one read of that instance and partition, unless one is queued. */
	readonly invalidate: (
		instance: string,
		sync: string,
		partition: string
	) => Effect.Effect<void, EngineError>;
	/** A verified webhook delivery: stored once per read sync over the instance's definition, then one debounced read each. */
	readonly hint: (instance: string, delivery: WebhookDelivery) => Effect.Effect<void, EngineError>;
	readonly health: (instance: string) => Effect.Effect<SyncHealth, EngineError>;
	readonly replay: (
		instance: string,
		ids?: readonly string[]
	) => Effect.Effect<{ readonly replayed: number }, EngineError>;
	readonly deadLetters: (instance: string) => Effect.Effect<readonly SyncDeadLetter[], EngineError>;
	readonly retire: (
		instance: string,
		id: string,
		actor: string
	) => Effect.Effect<{ readonly retired: number }, EngineError>;
	/** The definition's `test` body for a paired instance: fails with the body's failure; no body passes. */
	readonly test: (instance: string) => Effect.Effect<void, EngineError>;
};
export class Syncs extends Context.Service<Syncs, SyncsShape>()('bolt/Syncs') {}

/** What the sync areas run against, built once per activation. */
export type SyncEngine = {
	readonly manifest: EngineManifest;
	readonly db: TenantDbShape;
	readonly act: WritesShape['act'];
	readonly read: ReadsShape['run'];
	readonly authority: IdentityShape['authority'];
	readonly bindings: () => Effect.Effect<Bindings>;
	readonly guest: GuestShape;
	readonly links: Drivers['Service'];
	readonly live: LiveShape;
	readonly crypto: Crypto.Crypto;
	readonly announce: (at: string) => Effect.Effect<void>;
	/** A patch onto the instance's `status` (its health), when it changed. */
	readonly status: (
		instance: string,
		patch: { readonly [key: string]: Json }
	) => Effect.Effect<void, EngineError>;
	/** This environment's epoch: an outbox row of another (a fork, a restore) is never sent. */
	readonly epoch: string;
};

export const SyncsLive = Layer.effect(
	Syncs,
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
			activation = yield* Activation,
			registry = yield* RunHandlers;
		const context = yield* Effect.context<TenantDb | Manifest | Live | Wake>();
		const e: SyncEngine = {
			manifest,
			db,
			act: writes.act,
			read: reads.run,
			authority: identity.authority,
			bindings: () =>
				Clock.currentTimeMillis.pipe(Effect.map((ms) => bindingsAt(ms, manifest.workspace.tz))),
			guest,
			links: drivers,
			live,
			crypto: yield* Crypto.Crypto,
			announce: wake.at,
			status: (instance, patch) =>
				writeStatus(instance, patch).pipe(Effect.provideContext(context)),
			epoch: activation.epoch
		};
		const reading = makeRead(e),
			delivering = makeDeliver(e),
			backfilling = makeBackfill(e),
			hinting = makeHint(e);
		const syncs = [...syncs_of(manifest).values()];
		yield* registry.register(
			{
				...Object.fromEntries(
					syncs
						.filter((s) => s.read)
						.map((s) => [
							s.name,
							(input: Json, run: Parameters<RunHandler>[1]) => reading.run(s, input, run)
						])
				),
				[SYNC_DELIVER]: () => delivering.deliver,
				[SYNC_BACKFILL]: (input) => backfilling(input)
			},
			{
				...Object.fromEntries(syncs.filter((s) => s.read).map((s) => [s.name, { attempts: 3, backoff: '10s' }])),
				[SYNC_BACKFILL]: { attempts: 3, backoff: '10s' }
			},
			Object.fromEntries(
				syncs.filter((s) => s.read).map((s) => [s.name, (now: number) => reading.rests(s, now)])
			)
		);
		return {
			health: Effect.fn('Syncs.health')(function* (instance: string) {
				const ms = yield* Clock.currentTimeMillis,
					now = iso(ms);
				const c = new Chain(), selected = c.p(instance), at = c.p(now);
				const failed = c.cte('initialization_failures', failedBackfills(manifest, c, instance));
				const definitions = c.p(JSON.stringify(Object.entries(manifest.integrations).flatMap(([name, definition]) =>
					definition.webhook === undefined ? [] : [name])));
				// `Chain.sql` also answers its `guarded` count: the health is the one named column
				const [answer] = yield* db.rows(Schema.Struct({ health: SyncHealth }), c.sql(`(SELECT jsonb_build_object(
					'pending', (SELECT count(*)::int FROM sys_outbox WHERE instance = ${selected} AND status IN ('queued','sending')),
					'dead', (SELECT count(*)::int FROM sys_outbox WHERE instance = ${selected} AND status = 'dead'),
					'failed', (SELECT count(*)::int FROM sys_outbox WHERE instance = ${selected} AND status = 'failed'),
					'initialization', (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
						'failed', count(*)::int, 'message', (SELECT coalesce(error ->> 'message', error ->> 'code')
						FROM ${failed} ORDER BY finished_at DESC NULLS LAST, id LIMIT 1)) END FROM ${failed}),
					'last_read_at', max(last_read_at)::text, 'last_change_at', max(last_change_at)::text,
					'last_hint_at', greatest(max(last_hint_at), (SELECT max(received_at) FROM sys_inbox
						WHERE instance = ${selected} AND body ->> 'kind' = 'webhook'))::text,
					'lag_seconds', extract(epoch FROM (${at}::timestamptz - max(last_read_at)))::float,
					'webhooks_quiet', EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = ${selected} AND i.integration IN
						(SELECT jsonb_array_elements_text(${definitions}::jsonb))) AND coalesce(max(last_change_at) > coalesce(
						greatest(max(last_hint_at), (SELECT max(received_at) FROM sys_inbox WHERE instance = ${selected}
						AND body ->> 'kind' = 'webhook')), min(started_at)) + interval '30 minutes', false)
				) FROM sys_sync WHERE instance = ${selected}) AS health`));
				if (answer === undefined)
					return yield* BoltError.make('corrupt', 'decode', 'the sync health read returned no row');
				const health = answer.health;
				// a read that found nothing commits nothing, so this generation's memory may be the newer
				const read = reading.lastReadOf(instance);
				return read > Date.parse(health.last_read_at ?? '1970-01-01')
					? { ...health, last_read_at: iso(read), lag_seconds: (ms - read) / 1000 }
					: health;
			}),
			deadLetters: (instance: string) =>
				db.rows(SyncDeadLetter, {
					text: `SELECT id::text, model, record, record_revision AS revision, op, at::text,
						error ->> 'message' AS message FROM sys_outbox
						WHERE instance = $1 AND status = 'dead' ORDER BY seq LIMIT 50`,
					params: [instance]
				}),
			retire: Effect.fn('Syncs.retire')(function* (instance: string, id: string, actor: string) {
				const now = iso(yield* Clock.currentTimeMillis),
					c = new Chain();
				c.cte(
					'retired',
					`UPDATE sys_outbox SET status = 'skipped',
					error = coalesce(error, '{}'::jsonb) || jsonb_build_object('retired', jsonb_build_object(
						'at', ${c.p(now)}::text, 'by', ${c.p(actor)}::text))
					WHERE instance = ${c.p(instance)} AND id::text = ${c.p(id)} AND status = 'dead'
					RETURNING id, model, record, key`
				);
				c.cte(
					'sends_skipped',
					`UPDATE sys_message SET status = 'skipped', error = 'The source write was retired.'
					WHERE meta ->> 'sync_write' IN (SELECT key FROM retired) AND status = 'queued' RETURNING id`
				);
				deliverRun(c, 'sends_skipped', now);
				enqueue(
					c,
					[{ automation: SYNC_DELIVER, input: {}, dueAt: now, cause: 'schedule', depth: 0 }],
					{ when: 'EXISTS (SELECT 1 FROM retired)' }
				);
				const [row] = yield* db.returning(
					Schema.Struct({
						model: Schema.NullOr(Schema.String),
						record: Schema.NullOr(Schema.String)
					}),
					c.sql('(SELECT model FROM retired) AS model, (SELECT record FROM retired) AS record')
				);
				if (row?.model && row.record) {
					live.syncChanged('sys_integration', [instance]);
					live.syncChanged(row.model, [row.record]);
					yield* wake.at(now);
				}
				return { retired: row?.model ? 1 : 0 };
			}),
			replay: Effect.fn('Syncs.replay')(function* (instance: string, ids?: readonly string[]) {
				const now = iso(yield* Clock.currentTimeMillis),
					c = new Chain();
				capturePiece(c,
					'replayed',
					'sys_outbox',
					`UPDATE sys_outbox SET status = 'sending', attempts = 0,
					claimed_at = ${c.p(now)}::timestamptz - interval '6 minutes', next_attempt_at = ${c.p(now)}::timestamptz,
					error = CASE WHEN error ->> 'code' = 'identity_conflict' THEN error ELSE NULL END
					WHERE instance = ${c.p(instance)} AND status = 'dead'
					${ids === undefined ? '' : `AND id::text IN (SELECT jsonb_array_elements_text(${c.p(ids)}::jsonb))`}`
				);
				enqueueDrain(c, SYNC_DELIVER, c.p(now), 'EXISTS (SELECT 1 FROM replayed)');
				const initialized = ids === undefined ? replayBackfills(manifest, c, instance, now) : null;
				const answer = yield* nativeCommit(db.write, live.publish, c,
					Schema.Struct({ ...CapturedResult.fields, replayed: Schema.Number }),
					`((SELECT count(*)::int FROM replayed) + ${initialized === null ? '0' : `(SELECT count(*)::int FROM ${initialized})`}) AS replayed`
				);
				if (answer.replayed > 0) {
					yield* wake.at(now);
				}
				return { replayed: answer.replayed };
			}),
			invalidate: reading.invalidate,
			hint: hinting.hint,
			test: Effect.fn('Syncs.test')(function* (instance: string) {
				const [inst] = yield* instancesOf(manifest, db, { ids: [instance] });
				if (inst === undefined)
					return yield* Effect.fail(
						BoltError.make('not_found', 'decode', `No integration instance '${instance}'.`)
					);
				if (manifest.integrations[inst.integration]?.test !== true) return;
				const id = yield* uuid(e.crypto);
				yield* integrationBody(e, {
					id,
					actor: { kind: 'system', run: id, by: { platform: `${inst.integration}.test` } },
					kind: 'integration',
					target: `integration_definition.${inst.integration}.bodies.test`,
					args: [{ $ctx: true }],
					instance,
					configuration: inst.configuration
				});
			})
		};
	})
);

export { syncState } from './write.ts';
