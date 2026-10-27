// Syncs (spec §3): a model's rows exchanged with another system through an integration instance. A remote sync's
// author writes at most two guest bodies — `read` (their rows → the model's) and `write` (one committed change → a call
// to them) — and the engine owns the rest in the tenant's own Postgres: the read run (`read.ts`: one act per page with
// its cursor, id map and `$version` guard in the same statement), the webhook inbox (`hint.ts`: verified deliveries
// stored once, then a debounced read), and the outbox (`write.ts`: queued in the statement that wrote the record,
// delivered FIFO per record with retries, dead letter, rollback on refusal). File syncs are `file.ts`'s.
//
// Which instance: a model's ref to `sys_integration` pinned to the sync's integration (`where: { integration: { eq } }`)
// picks it per row (a write follows the row's FK; a read stamps it); otherwise a read runs for every active instance and a
// write goes through the one `+workspace.ts` connection of that integration.
import { Clock, Context, Crypto, Effect, Layer, Predicate, Schema } from 'effect';
import { bindingsAt } from '../query/reader.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Drivers } from '../ports.ts';
import {
	Activation,
	Guest,
	Identity,
	Live,
	Manifest,
	Reads,
	RunHandlers,
	Wake,
	Writes,
	type GuestShape,
	type IdentityShape,
	type LiveShape,
	type ReadsShape,
	type WritesShape
} from '../services.ts';
import { relations, type EngineManifest } from '../manifest.ts';
import type { SyncEntry } from '../../decl/model.ts';
import type { Json } from '../../decl/values.ts';
import type { WebhookDelivery } from '../../decl/runtime/integration.ts';
import type { Bindings, CronEntry, EngineActor } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { duration, iso } from '../runs/time.ts';
import { instancesOf, integrationBody, writeStatus } from '../integrations/instances.ts';
import { makeRead } from './read.ts';
import { makeDeliver, SYNC_DELIVER } from './write.ts';
import { Chain } from '../write/sql.ts';
import { enqueue } from '../runs/queue.ts';
import { makeHint } from './hint.ts';

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
	/** The model's ref to `sys_integration` pinned to `definition`: it picks the instance per row. */
	readonly fk: string | undefined;
	/** Without `fk`, the `+workspace.ts` connection of `definition` a write goes through. */
	readonly connection: string | undefined;
	/** How often its read runs (`every`, default `'15min'`). */
	readonly every: string;
	/** The configuration field whose values partition its read (one cursor each). */
	readonly partitions: string | undefined;
	readonly entry: SyncEntry;
};
export const EVERY = '15min';
const memo = new WeakMap<EngineManifest, ReadonlyMap<string, RemoteSync>>();
/** Every remote sync by its run name `'<model>.sync.<sync>'`. */
export const syncsOf = (m: EngineManifest): ReadonlyMap<string, RemoteSync> => {
	let x = memo.get(m);
	if (x === undefined) {
		const rels = relations(m);
		x = new Map(
			Object.entries(m.exposures).flatMap(([model, c]) =>
				Object.entries(c.syncs ?? {}).flatMap(([sync, entry]): [string, RemoteSync][] => {
					if (entry.with === 'file') return [];
					const pinned = (rels.from.get(model) ?? []).find((r) => {
						const where = r.spec.where;
						return (
							r.targets.length === 1 &&
							r.targets[0] === 'sys_integration' &&
							Predicate.isObject(where) &&
							Predicate.hasProperty(where, 'integration') &&
							Predicate.isObject(where.integration) &&
							Predicate.hasProperty(where.integration, 'eq') &&
							where.integration.eq === entry.with
						);
					});
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
								fk: pinned?.fk,
								connection: Object.entries(m.connections).find(
									([, slot]) => slot.integration === entry.with
								)?.[0],
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
	[...syncsOf(m).values()]
		.filter((s) => s.read)
		.map((s) => ({ id: s.name, cron: everyCron(s.every), zone: m.workspace.tz }));

/** What a sync writes and reads as: the system actor of that sync on that instance (never sent back through it). */
export const syncActor = (s: RemoteSync, instance: string, run: string): EngineActor => ({
	kind: 'system',
	run,
	by: { sync: s.name, instance }
});

export { SyncHealth } from './health-schema.ts';
import { SyncHealth } from './health-schema.ts';
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
			hinting = makeHint(e);
		const syncs = [...syncsOf(manifest).values()];
		yield* registry.register(
			{
				...Object.fromEntries(
					syncs
						.filter((s) => s.read)
						.map((s) => [
							s.name,
							(input: Json, run: { readonly id: string }) => reading.run(s, input, run.id)
						])
				),
				[SYNC_DELIVER]: () => delivering.deliver
			},
			Object.fromEntries(
				syncs.filter((s) => s.read).map((s) => [s.name, { attempts: 3, backoff: '10s' }])
			)
		);
		return {
			health: Effect.fn('Syncs.health')(function* (instance: string) {
				const now = iso(yield* Clock.currentTimeMillis);
				return yield* db.value(SyncHealth, {
					text: `SELECT jsonb_build_object(
						'pending', (SELECT count(*)::int FROM sys_outbox WHERE instance = $1 AND status IN ('queued','sending')),
						'dead', (SELECT count(*)::int FROM sys_outbox WHERE instance = $1 AND status = 'dead'),
						'failed', (SELECT count(*)::int FROM sys_outbox WHERE instance = $1 AND status = 'failed'),
						'last_read_at', max(last_read_at)::text, 'last_change_at', max(last_change_at)::text, 'last_hint_at', greatest(max(last_hint_at), (SELECT max(received_at) FROM sys_inbox WHERE instance = $1 AND body ->> 'kind' = 'webhook'))::text,
						'lag_seconds', extract(epoch FROM ($2::timestamptz - max(last_read_at)))::float,
						'webhooks_quiet', EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = $1 AND i.integration IN
							(SELECT jsonb_array_elements_text($3::jsonb))) AND coalesce(max(last_change_at) > coalesce(greatest(max(last_hint_at), (SELECT max(received_at) FROM sys_inbox WHERE instance = $1 AND body ->> 'kind' = 'webhook')), min(started_at)) + interval '30 minutes', false)
					) AS health FROM sys_sync WHERE instance = $1`,
					params: [
						instance,
						now,
						JSON.stringify(
							Object.entries(manifest.integrations).flatMap(([name, definition]) =>
								definition.webhook === undefined ? [] : [name]
							)
						)
					]
				});
			}),
			replay: Effect.fn('Syncs.replay')(function* (instance: string, ids?: readonly string[]) {
				const now = iso(yield* Clock.currentTimeMillis),
					c = new Chain();
				c.cte(
					'replayed',
					`UPDATE sys_outbox SET status = 'sending', attempts = 0,
					claimed_at = ${c.p(now)}::timestamptz - interval '6 minutes', next_attempt_at = ${c.p(now)}::timestamptz, error = NULL
					WHERE instance = ${c.p(instance)} AND status = 'dead'
					${ids === undefined ? '' : `AND id::text IN (SELECT jsonb_array_elements_text(${c.p(ids)}::jsonb))`} RETURNING id, model, record`
				);
				enqueue(
					c,
					[{ automation: SYNC_DELIVER, input: {}, dueAt: now, cause: 'schedule', depth: 0 }],
					{ when: 'EXISTS (SELECT 1 FROM replayed)' }
				);
				const [answer] = yield* db.returning(
					Schema.Struct({ replayed: Schema.Number }),
					c.sql('(SELECT count(*)::int FROM replayed) AS replayed')
				);
				if ((answer?.replayed ?? 0) > 0) {
					live.syncChanged('sys_integration', [instance]);
					yield* wake.at(now);
				}
				return answer ?? { replayed: 0 };
			}),
			invalidate: reading.invalidate,
			hint: hinting.hint,
			test: Effect.fn('Syncs.test')(function* (instance: string) {
				const [inst] = yield* instancesOf(manifest, db, { ids: [instance] });
				if (inst === undefined)
					return yield* Effect.fail(
						BoltError.make('notFound', 'decode', `No integration instance '${instance}'.`)
					);
				if (manifest.integrations[inst.integration]?.test !== true) return;
				const id = yield* e.crypto.randomUUIDv4().pipe(
					Effect.mapError((error) =>
						BoltError.make(
							'unavailable',
							'facility',
							'Secure random UUID generation failed.',
							error
						)
					)
				);
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
