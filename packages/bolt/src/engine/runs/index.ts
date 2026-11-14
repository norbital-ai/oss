import {
	Cause,
	Clock,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	Option,
	PubSub,
	Semaphore
} from 'effect';
import type { Row } from './rows.ts';
import { makeParking } from '../parking.ts';
import type { EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Drivers } from '../ports.ts';
import {
	Deadlines,
	Live,
	Manifest,
	RunEnds,
	RunHandlers,
	Runs,
	Wake,
	type RetrySpec,
	type RunHandler,
	type RunRest
} from '../services.ts';

import { canonical, sha256_hex } from '@norbital-ai/store';
import { makePruner, PRUNE } from './prune.ts';
import { makeRunExecutor } from './executor.ts';
import { makeRunStore } from './store.ts';
import { cronLedger } from './ledger.ts';
import { triggers_of } from './queue.ts';
import { iso } from './time.ts';
import { notice_push } from './push.ts';
import { NOTICE_PUSH } from '../notifications/queue.ts';
import { fileSyncHandlers } from '../sync/file.ts';
import { syncTriggers } from '../sync/index.ts';
import { EMBED, embedRun } from '../integrations/embed.ts';
import { INDEX, indexRun } from '../write/index-run.ts';
/** How soon a parked generation's wake asks again. */
const PARKED_WAKE_MS = 5_000,
	/** How often an awake database's queue is checked for a wake lost after its commit: Neon's idle window. */
	RECHECK_MS = 5 * 60_000;
export const WakeLive = Layer.effect(
	Wake,
	Effect.gen(function* () {
		const deadlines = yield* Deadlines;
		return { at: deadlines.announce };
	})
).pipe(
	Layer.provideMerge(
		Layer.effect(RunEnds, PubSub.unbounded<readonly string[]>())
	)
);
export const RunHandlersLive = Layer.sync(RunHandlers, () => {
	const handlers = new Map<string, RunHandler>(),
		retries = new Map<string, RetrySpec>();
	const rests = new Map<string, RunRest>();
	return {
		register: (
			next: {
				readonly [name: string]: RunHandler;
			},
			policy: {
				readonly [name: string]: RetrySpec;
			} = {},
			resting: {
				readonly [name: string]: RunRest;
			} = {}
		) =>
			Effect.sync(() => {
				for (const [name, handler] of Object.entries(next)) handlers.set(name, handler);
				for (const [name, retry] of Object.entries(policy)) retries.set(name, retry);
				for (const [name, rest] of Object.entries(resting)) rests.set(name, rest);
			}),
		handler: (name: string) => Effect.sync(() => Option.fromNullishOr(handlers.get(name))),
		resting: (name: string, now: number) => rests.get(name)?.(now) ?? Effect.succeed(undefined),
		retry: (name: string) => Effect.sync(() => Option.fromNullishOr(retries.get(name)))
	};
});
export const RunsLive = Layer.effect(
	Runs,
	Effect.gen(function* () {
		const m = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			registry = yield* RunHandlers,
			deadlines = yield* Deadlines,
			drivers = yield* Drivers;
		const crons = [...triggers_of(m).crons, ...(drivers.available ? syncTriggers(m) : [])];
		const stopping = new Set<string>();
		/** A running run's stop signal: `stop` completes it, which ends the crossing in flight (an inference has no time limit). */
		const halts = new Map<string, Deferred.Deferred<void>>();
		const tickPermit = yield* Semaphore.make(1),
			pulseGate = yield* Semaphore.make(1),
			/** The running automations: a planned close waits for them, and no run starts after it. */
			parking = makeParking();
		const capacities: Record<string, number> = {};
		for (const [name, automation] of Object.entries(m.automations))
			capacities[name] = automation.concurrency?.max ?? 1;
		// Local permits match native admission; undeclared platform handlers keep one permit.
		const locks = new Map<string, Semaphore.Semaphore>();
		/** Each resting cron's end, as this generation learned it. */
		const restEnds = new Map<string, number>();
		const lock = (automation: string) => {
			let held = locks.get(automation);
			if (held === undefined)
				locks.set(automation, (held = Semaphore.makeUnsafe(capacities[automation] ?? 1)));
			return held;
		};
		let activeTick: (() => Effect.Effect<void>) | undefined;
		const pulse = pulseGate.withPermit(Effect.suspend(() =>
			activeTick === undefined || parking.parked
				? Effect.succeed(false)
				: activeTick().pipe(Effect.as(true))));
		yield* registry.register({
			[NOTICE_PUSH]: yield* notice_push,
			[EMBED]: yield* embedRun,
			[INDEX]: yield* indexRun,
			...(yield* fileSyncHandlers)
		}, { [NOTICE_PUSH]: { attempts: 3, backoff: '10s' } });
		const announce = (yield* Wake).at;
		const { boot, claim, next, view, stop } = yield* makeRunStore(parking, capacities, halts, stopping);
		const { prune, daily } = yield* makePruner();

		const { execute, leased } = yield* makeRunExecutor(parking, halts, stopping, prune);
		const tick = tickPermit.withPermit(
			Effect.scoped(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					// parked, this generation is closing: the wake comes back soon and lands on the next one
					if (parking.parked) return yield* deadlines.settle(iso(now + PARKED_WAKE_MS));
					const inflight = yield* FiberSet.make<void, never>();
					const fork = yield* FiberSet.runtime(inflight)();
					let errors: Cause.Cause<EngineError> = Cause.empty;
					const dues: number[] = [];
					const track = (work: Effect.Effect<void, EngineError>) =>
						Effect.sync(() => {
							fork(work.pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() => {
										errors = Cause.combine(errors, cause);
									})
								)
							));
						});
					const run = (rows: readonly Row[]) =>
						lock(rows[0]?.automation ?? '')
							.withPermit(execute(rows))
							.pipe(
								Effect.tap((times) =>
									Effect.sync(() => {
										dues.push(...times);
									})
								),
								Effect.asVoid
							);
					const pass = yield* daily(now);
					let pruned = pass !== undefined;
					if (pass?.continued !== undefined) dues.push(pass.continued);
					let requested = false, claiming: object | undefined;
					// an authored automation's runs side by side, up to its concurrency; a platform automation's one after another.
					// Each settled run frees room in its automation: it claims again.
					const start = (claimed: readonly Row[]) => {
						if (claimed.some((row) => row.automation === PRUNE)) pruned = true;
						return Effect.forEach(
							Map.groupBy(claimed, (row) => row.automation),
							([automation, rows]) => m.automations[automation] === undefined
								? track(leased(rows, Effect.forEach(rows, (row) => run([row]), { discard: true })).pipe(Effect.ensuring(pulse)))
								: Effect.forEach(rows, (row) => track(leased([row], run([row])).pipe(Effect.ensuring(pulse))), { discard: true }),
							{ discard: true }
						);
					};
					const scan = (token: object) => Effect.gen(function* () {
						for (;;) {
							yield* pulseGate.withPermit(Effect.sync(() => { requested = false; }));
							yield* start(yield* claim(yield* Clock.currentTimeMillis, pruned));
							const again = yield* pulseGate.withPermit(Effect.sync(() => {
								if (requested) return true;
								claiming = undefined;
								return false;
							}));
							if (!again) return;
						}
					}).pipe(Effect.ensuring(pulseGate.withPermit(Effect.sync(() => {
						if (claiming === token) claiming = undefined;
					}))));
					yield* pulseGate.withPermit(Effect.sync(() => {
						activeTick = () => Effect.suspend(() => {
							requested = true;
							if (claiming !== undefined) return Effect.void;
							const token = {};
							claiming = token;
							return track(scan(token));
						});
					}));
					yield* pulse;
					for (;;) {
						yield* FiberSet.awaitEmpty(inflight);
						const closed = yield* pulseGate.withPermit(Effect.gen(function* () {
							if ((yield* FiberSet.size(inflight)) > 0) return false;
							activeTick = undefined;
							return true;
						}));
						if (closed) break;
					}
					const queued = yield* next;
					const earliest = Math.min(...dues, queued === null ? Infinity : Date.parse(queued));
					yield* deadlines.settle(Number.isFinite(earliest) ? iso(earliest) : null);
					if (errors.reasons.length > 0) return yield* Effect.failCause(errors);
				}).pipe(Effect.ensuring(pulseGate.withPermit(Effect.sync(() => { activeTick = undefined; }))))
			)
		);
		// A wake lost after its commit (a deadline port that failed): while the database is awake anyway, its next due run
		// is announced again; an asleep database is never woken for it. A process that died recovers at its next boot.
		yield* Effect.gen(function* () {
			for (;;) {
				yield* Effect.sleep(RECHECK_MS);
				if (!(yield* db.awake)) continue;
				const queued = yield* db.quietly(next).pipe(Effect.catch((cause) => Effect.logWarning('runs recheck', cause).pipe(Effect.as(null))));
				if (queued !== null) yield* announce(queued);
			}
		}).pipe(Effect.forkScoped);
		/** Cron `id` at `slot`: the run id is their digest, so a repeat meets the row its first effect wrote. */
		const fire = Effect.fn('Runs.fire')(function* (id: string, slot: string) {
			const at = Date.parse(slot);
			if (!crons.some((entry) => entry.id === id) || !Number.isFinite(at))
				return yield* Effect.fail(
					BoltError.make('invalid_input', 'admission', `no cron '${id}' fires at '${slot}'`)
				);
			const now = yield* Clock.currentTimeMillis;
			const until = yield* registry.resting(id, now);
			if (until !== undefined) return { ran: false, until: iso(until) };
			// a cron that rests depends on the data alone: while nothing touched the database, its last read still stands
			const rest = triggers_of(m).rests.get(id),
				rested = restEnds.get(id);
			if (rested !== undefined && rested > now && !(yield* db.awake))
				return { ran: false, until: iso(rested) };
			const run: Row = {
				id: sha256_hex(canonical(['cron', id, iso(at)])).slice(0, 32),
				automation: id,
				input: {},
				due_at: iso(at),
				run_key: null,
				cause: 'cron',
				depth: 0,
				attempts: 1,
				leases: 0,
				actor: null,
				starter: null,
				trigger: { kind: 'system', cause: 'cron' }
			};
			const ledger = yield* cronLedger(run, now).pipe(
				Effect.provideService(TenantDb, db), Effect.provideService(Live, live)
			);
			// a slot that only read leaves the database as idle as it found it, rest or not
			const dues = yield* db.quietly(leased([run], lock(run.automation).withPermit(execute([run], ledger))));
			if (dues.length > 0) yield* announce(iso(Math.min(...dues)));
			// a slot that used the database ticks once: its settle may have freed room for a queued run, and the tick prunes;
			// a pass is no reason to wake it
			if (ledger.written()) {
				restEnds.delete(id);
				yield* announce(iso(now));
				return { ran: true };
			}
			if (rest === undefined) return { ran: false };
			// on a whole multiple, so a workspace's resting crons wake its database together
			const end = (Math.floor(now / rest) + 1) * rest;
			restEnds.set(id, end);
			return { ran: false, until: iso(end) };
		});
		return {
			boot,
			tick,
			pulse,
			park: parking.park,
			view,
			stop,
			crons: Effect.succeed(crons),
			fire
		};
	})
);
