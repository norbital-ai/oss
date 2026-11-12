import { Cause, Clock, Duration, Effect, Exit, FiberHandle, FiberSet, Layer, Semaphore, type Scope } from 'effect';
import { DeadlinePort } from '../ports.ts';
import type { PortFailure } from '../port.ts';
import { Activation, Deadlines } from '../services.ts';

export type DeadlineEntry<Subject> = {
	readonly key: string;
	readonly subject: Subject;
	readonly at: number;
};
export type DeadlineCompletion = {
	readonly callbackAtEpochMs: number | null | undefined;
	readonly mergeAnnouncements: boolean;
};
export interface DeadlineTimer<Subject> {
	readonly announce: (key: string, subject: Subject, at: number) => Effect.Effect<boolean>;
	readonly settle: (key: string, subject: Subject, at: number | null) => Effect.Effect<void>;
	readonly retire: (key: string) => Effect.Effect<boolean>;
	readonly armedFor: Effect.Effect<number | undefined>;
}
type ActiveDeadline<Subject> = {
	readonly entry: DeadlineEntry<Subject>;
	retired: boolean;
	waking: boolean;
	pulsing: boolean;
	deferred: boolean;
	mergeAnnouncements: boolean;
};
type Due<Subject> = {
	readonly entry: DeadlineEntry<Subject>;
	readonly owner: ActiveDeadline<Subject>;
	readonly pulse: boolean;
};
const RETRY_MS = 60_000;

/** One clock timer; a due announcement during a wake signals its owner instead of starting another wake. */
export const DeadlineTimer = {
	make: <Subject, R = never>(callbacks: {
		readonly wake: (entry: DeadlineEntry<Subject>) => Effect.Effect<DeadlineCompletion, never, R>;
		/** False hands the notification back to the next wake, without spinning while the current one closes. */
		readonly pulse: (entry: DeadlineEntry<Subject>) => Effect.Effect<boolean, never, R>;
	}): Effect.Effect<DeadlineTimer<Subject>, never, Scope.Scope | R> => Effect.gen(function* () {
		const context = yield* Effect.context<R>();
		const clock = yield* Clock.Clock;
		const timer = yield* FiberHandle.make<void, never>();
		const workers = yield* FiberSet.make<void, never>();
		const gate = yield* Semaphore.make(1);
		const held = new Map<string, { subject: Subject; at: number }>();
		const active = new Map<string, ActiveDeadline<Subject>>();
		let armedFor: number | undefined, alarm = 0, stopped = false;
		yield* Effect.addFinalizer(() => Effect.sync(() => {
			stopped = true;
			armedFor = undefined;
			held.clear();
			active.clear();
		}));
		const eligible = (key: string) => {
			const owner = active.get(key);
			return owner === undefined || (owner.waking && !owner.pulsing && !owner.retired && !owner.deferred);
		};
		const arm: Effect.Effect<void> = Effect.gen(function* () {
			if (stopped) return;
			let earliest: number | undefined;
			for (const [key, entry] of held)
				if (eligible(key) && (earliest === undefined || entry.at < earliest)) earliest = entry.at;
			if (earliest === armedFor) return;
			armedFor = earliest;
			const token = ++alarm;
			if (earliest === undefined) return yield* FiberHandle.clear(timer);
			const at = earliest;
			yield* FiberHandle.run(timer, Effect.gen(function* () {
				// Absolute deadlines can exceed the platform timer range or move with the wall clock.
				for (;;) {
					const remaining = at - (yield* clock.currentTimeMillis);
					if (remaining <= 0) break;
					yield* clock.sleep(Duration.millis(Math.min(remaining, 2_147_483_647)));
				}
				yield* FiberSet.run(workers, dispatch(token));
			}));
		});
		const change = <A>(update: () => A): Effect.Effect<A> =>
			gate.withPermit(Effect.sync(update).pipe(Effect.tap(() => arm)));
		const keep = (entry: DeadlineEntry<Subject>) => {
			if ((held.get(entry.key)?.at ?? Infinity) > entry.at)
				held.set(entry.key, { subject: entry.subject, at: entry.at });
		};
		const release = (due: Due<Subject>) => {
			if (!due.owner.waking && !due.owner.pulsing) active.delete(due.entry.key);
		};
		const runWake = (due: Due<Subject>) => Effect.uninterruptible(Effect.gen(function* () {
			const result = yield* Effect.suspend(() => callbacks.wake(due.entry)).pipe(
				Effect.provideContext(context), Effect.interruptible, Effect.exit
			);
			if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)) yield* Effect.logWarning(result.cause);
			const completion: DeadlineCompletion = Exit.isSuccess(result) ? result.value : {
				callbackAtEpochMs: (yield* clock.currentTimeMillis) + RETRY_MS, mergeAnnouncements: false
			};
			yield* change(() => {
				if (stopped || active.get(due.entry.key) !== due.owner) return;
				due.owner.waking = false;
				due.owner.mergeAnnouncements = completion.mergeAnnouncements;
				if (!due.owner.retired) {
					const callbackAt = completion.callbackAtEpochMs != null && Number.isFinite(completion.callbackAtEpochMs)
						? completion.callbackAtEpochMs : undefined;
					const announced = held.get(due.entry.key)?.at;
					const at = completion.mergeAnnouncements
						? callbackAt === undefined ? announced : Math.min(callbackAt, announced ?? Infinity)
						: callbackAt;
					if (at === undefined) held.delete(due.entry.key);
					else held.set(due.entry.key, { subject: due.entry.subject, at });
				}
				release(due);
			});
		}));
		const runPulse = (due: Due<Subject>) => Effect.uninterruptible(Effect.gen(function* () {
			const result = yield* Effect.suspend(() => callbacks.pulse(due.entry)).pipe(
				Effect.provideContext(context), Effect.interruptible, Effect.exit
			);
			if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)) yield* Effect.logWarning(result.cause);
			const accepted = Exit.isSuccess(result) && result.value;
			yield* change(() => {
				if (stopped || active.get(due.entry.key) !== due.owner) return;
				due.owner.pulsing = false;
				if (!accepted && !due.owner.retired && (due.owner.waking || due.owner.mergeAnnouncements)) {
					keep(due.entry);
					due.owner.deferred = due.owner.waking;
				}
				release(due);
			});
		}));
		const dispatch = (token: number): Effect.Effect<void> => Effect.uninterruptible(Effect.gen(function* () {
			const now = yield* clock.currentTimeMillis;
			const due = yield* change((): Due<Subject> | undefined => {
				if (stopped || token !== alarm) return undefined;
				armedFor = undefined;
				let taken: DeadlineEntry<Subject> | undefined;
				for (const [key, entry] of held)
					if (eligible(key) && entry.at <= now && (taken === undefined || entry.at < taken.at)) taken = { key, ...entry };
				if (taken === undefined) return undefined;
				held.delete(taken.key);
				const owner = active.get(taken.key);
				if (owner !== undefined) {
					owner.pulsing = true;
					return { entry: { ...taken, subject: owner.entry.subject }, owner, pulse: true };
				}
				const admitted: ActiveDeadline<Subject> = {
					entry: taken, retired: false, waking: true, pulsing: false, deferred: false, mergeAnnouncements: true
				};
				active.set(taken.key, admitted);
				return { entry: taken, owner: admitted, pulse: false };
			});
			if (due !== undefined) yield* FiberSet.run(workers, due.pulse ? runPulse(due) : runWake(due));
		}));
		return {
			announce: (key, subject, at) => change(() => {
				if (stopped || (held.get(key)?.at ?? Infinity) <= at) return false;
				held.set(key, { subject, at });
				return true;
			}),
			settle: (key, subject, at) => change(() => {
				if (stopped) return;
				if (at === null) held.delete(key);
				else held.set(key, { subject, at });
			}),
			retire: (key) => change(() => {
				held.delete(key);
				const owner = active.get(key);
				if (owner === undefined) return true;
				owner.retired = true;
				return false;
			}),
			armedFor: Effect.sync(() => armedFor)
		};
	})
};

export const in_process_deadlines = <E, R>(callbacks: {
	readonly wake: (scope: string) => Effect.Effect<void, E, R>;
	readonly pulse: (scope: string) => Effect.Effect<boolean, E, R>;
}) => Layer.effect(DeadlinePort, Effect.gen(function* () {
	const answers = new Map<string, number | null>();
	const waking = new Set<string>();
	const timer = yield* DeadlineTimer.make<string, R>({
		wake: (entry) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
			waking.add(entry.key);
			answers.delete(entry.key);
			const result = yield* restore(callbacks.wake(entry.subject)).pipe(Effect.tapCause(Effect.logWarning), Effect.exit);
			waking.delete(entry.key);
			const settled = Exit.isSuccess(result) || answers.has(entry.key);
			const callbackAtEpochMs = settled ? answers.get(entry.key) : (yield* Clock.currentTimeMillis) + RETRY_MS;
			answers.delete(entry.key);
			return { callbackAtEpochMs, mergeAnnouncements: settled };
		})),
		pulse: (entry) => callbacks.pulse(entry.subject).pipe(
			Effect.tapCause(Effect.logWarning), Effect.catchCause(() => Effect.succeed(false))
		)
	});
	return {
		announce: (scope: string, at: string) => timer.announce(scope, scope, Date.parse(at)).pipe(Effect.asVoid),
		settle: (scope: string, at: string | null) => Effect.suspend(() => waking.has(scope)
			? Effect.sync(() => { answers.set(scope, at === null ? null : Date.parse(at)); })
			: timer.settle(scope, scope, at === null ? null : Date.parse(at))),
		teardown: (scope: string) => timer.retire(scope).pipe(Effect.asVoid)
	};
}));

export const DeadlinesLive = Layer.effect(Deadlines, Effect.gen(function* () {
	const port = yield* DeadlinePort;
	const activation = yield* Activation;
	const absent = (effect: Effect.Effect<void, PortFailure>) =>
		effect.pipe(
			Effect.catchTags({
				Unavailable: () => Effect.void,
				FacilityFailure: (failure) => Effect.logWarning('deadline port failed', failure)
			})
		);
	yield* Effect.addFinalizer(() => absent(port.teardown(activation.scope)));
	return {
		announce: (at: string) => absent(port.announce(activation.scope, at)),
		settle: (at: string | null) => absent(port.settle(activation.scope, at))
	};
}));
