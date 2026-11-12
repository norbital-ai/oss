import {
	Cause,
	Clock,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	Option,
	PubSub,
	Schema,
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
/** Workspace automations that may run side by side; one automation's own runs stay one at a time. */
const LANES = 12,
	/** How soon a parked generation's wake asks again. */
	PARKED_WAKE_MS = 5_000;
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
		// A lane's claim commits before the next one checks the automation's remaining capacity.
		const lanes = yield* Semaphore.make(LANES),
			claims = yield* Semaphore.make(1),
			tickPermit = yield* Semaphore.make(1),
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
		const { boot, claim, view, stop } = yield* makeRunStore(parking, capacities, halts, stopping);
		const { prune, daily } = yield* makePruner();

		const { execute, interrupted } = yield* makeRunExecutor(parking, halts, stopping, prune);
		const tick = tickPermit.withPermit(
			Effect.scoped(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					// parked, this generation is closing: the wake comes back soon and lands on the next one
					if (parking.parked) return yield* deadlines.settle(iso(now + PARKED_WAKE_MS));
					const inflight = yield* FiberSet.make<void, never>();
					const fork = yield* FiberSet.runtime(inflight)();
					let errors: Cause.Cause<EngineError> = Cause.empty,
						pruned = false;
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
					const run = (group: readonly Row[]) =>
						lock(group[0]?.automation ?? '')
							.withPermit(execute(group))
							.pipe(
								Effect.tap((times) =>
									Effect.sync(() => {
										dues.push(...times);
									})
								),
								Effect.asVoid
							);
					const custom = Effect.gen(function* () {
						while (true) {
							const admitted = yield* lanes.withPermitsIfAvailable(1)(
								Effect.uninterruptibleMask((restore) =>
									Effect.gen(function* () {
										const claimed = yield* claims.withPermit(
											claim(yield* Clock.currentTimeMillis, pruned, true)
										);
										if (claimed.runs.length === 0) return false;
										yield* restore(run(claimed.runs)).pipe(
											Effect.onInterrupt(() =>
												interrupted(
													claimed.runs,
													'The admitted run was interrupted before its lane drained.'
												)
											)
										);
										return true;
									})
								)
							);
							if (Option.isNone(admitted) || !admitted.value) return;
						}
					});
					const start = (claimed: readonly Row[]) => {
						if (claimed.some((row) => row.automation === PRUNE)) pruned = true;
						return Effect.forEach(
							[...Map.groupBy(claimed, (row) => row.automation)],
							([, rows]) => track(Effect.forEach(rows, (row) => run([row]), { discard: true })),
							{ discard: true }
						).pipe(
							Effect.andThen(
								Effect.forEach(Array.from({ length: LANES }), () => track(custom), {
									discard: true
								})
							)
						);
					};
					const pass = yield* daily(now);
					pruned = pass !== undefined;
					if (pass?.continued !== undefined) dues.push(pass.continued);
					let requested = false, claiming: object | undefined;
					const scan = (token: object) => Effect.gen(function* () {
						for (;;) {
							yield* pulseGate.withPermit(Effect.sync(() => { requested = false; }));
							const claimed = yield* claim(yield* Clock.currentTimeMillis, pruned);
							yield* start(claimed.runs);
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
					const next = yield* db.value(Schema.NullOr(Schema.String), {
						text: `SELECT min(due_at)::text AS next FROM sys_run WHERE state = 'queued'`,
						params: []
					});
					const earliest = Math.min(...dues, next === null ? Infinity : Date.parse(next));
					yield* deadlines.settle(Number.isFinite(earliest) ? iso(earliest) : null);
					if (errors.reasons.length > 0) return yield* Effect.failCause(errors);
				}).pipe(Effect.ensuring(pulseGate.withPermit(Effect.sync(() => { activeTick = undefined; }))))
			)
		);
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
			const running = lock(run.automation).withPermit(
				execute([run], ledger)
			);
			const dues = yield* rest === undefined ? running : db.quietly(running);
			if (dues.length > 0) yield* announce(iso(Math.min(...dues)));
			// only a slot that used the database prunes it: a pass is no reason to wake it
			if (ledger.written()) {
				restEnds.delete(id);
				const pass = yield* daily(now);
				if (pass?.continued !== undefined) yield* announce(iso(pass.continued));
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
