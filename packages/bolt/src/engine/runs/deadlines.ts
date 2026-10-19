import { Clock, Duration, Effect, FiberHandle, FiberSet, Layer, type Scope } from 'effect';
import { DeadlinePort } from '../ports.ts';
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
export type DeadlineResolution<Subject> = {
	readonly subject: Subject;
	readonly at: number | undefined;
	readonly stale: boolean;
};
export interface DeadlineTimer<Subject> {
	readonly announce: (key: string, subject: Subject, at: number) => Effect.Effect<boolean>;
	readonly settle: (key: string, subject: Subject, at: number | null) => Effect.Effect<void>;
	readonly retire: (key: string) => Effect.Effect<boolean>;
	readonly restore: (entries: Iterable<DeadlineEntry<Subject>>) => Effect.Effect<void>;
	readonly takeDue: Effect.Effect<DeadlineEntry<Subject> | undefined>;
	readonly complete: (
		key: string,
		completion: DeadlineCompletion
	) => Effect.Effect<DeadlineResolution<Subject>>;
	readonly armedFor: Effect.Effect<number | undefined>;
}

export const DeadlineTimer = {
	make: <Subject, R = never>(
		onDue: Effect.Effect<void, never, R>
	): Effect.Effect<DeadlineTimer<Subject>, never, Scope.Scope | R> =>
		Effect.gen(function* () {
			const context = yield* Effect.context<R>();
			const clock = yield* Clock.Clock;
			const timer = yield* FiberHandle.make<void, never>();
			const callbacks = yield* FiberSet.make<void, never>();
			const held = new Map<string, { subject: Subject; at: number }>();
			const active = new Map<string, { entry: DeadlineEntry<Subject>; retired: boolean }>();
			let armedFor: number | undefined;
			let stopped = false;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					stopped = true;
					armedFor = undefined;
				})
			);
			const arm = Effect.gen(function* () {
				let earliest: number | undefined;
				for (const [key, entry] of held)
					if (!active.has(key) && (earliest === undefined || entry.at < earliest))
						earliest = entry.at;
				if (stopped || earliest === undefined) {
					armedFor = undefined;
					yield* FiberHandle.clear(timer);
					return;
				}
				if (earliest === armedFor) return;
				armedFor = earliest;
				const at = earliest;
				const sleepUntil = Effect.gen(function* () {
					for (;;) {
						const remaining = at - (yield* clock.currentTimeMillis);
						if (remaining <= 0) return;
						yield* clock.sleep(Duration.millis(Math.min(remaining, 2_147_483_647)));
					}
				});
				yield* FiberHandle.run(
					timer,
					sleepUntil.pipe(
						Effect.andThen(
							Effect.sync(() => {
								armedFor = undefined;
							})
						),
						Effect.andThen(FiberSet.run(callbacks, Effect.provideContext(onDue, context))),
						Effect.asVoid
					)
				);
			});
			const armed = <A>(change: () => A): Effect.Effect<A> =>
				Effect.sync(change).pipe(Effect.tap(() => arm));
			return {
				announce: (key, subject, at) =>
					armed(() => {
						if (stopped || (held.get(key)?.at ?? Infinity) <= at) return false;
						held.set(key, { subject, at });
						return true;
					}),
				settle: (key, subject, at) =>
					armed(() => {
						if (stopped) return;
						if (at === null) held.delete(key);
						else held.set(key, { subject, at });
					}),
				retire: (key) =>
					armed(() => {
						held.delete(key);
						const running = active.get(key);
						if (running === undefined) return true;
						running.retired = true;
						return false;
					}),
				restore: (entries) =>
					armed(() => {
						for (const entry of entries)
							if (!held.has(entry.key) && !active.has(entry.key)) held.set(entry.key, entry);
					}),
				takeDue: Effect.gen(function* () {
					const now = yield* clock.currentTimeMillis;
					return yield* armed(() => {
						if (stopped) return undefined;
						let taken: DeadlineEntry<Subject> | undefined;
						for (const [key, entry] of held)
							if (
								!active.has(key) &&
								entry.at <= now &&
								(taken === undefined || entry.at < taken.at)
							)
								taken = { key, ...entry };
						if (taken !== undefined) {
							held.delete(taken.key);
							active.set(taken.key, { entry: taken, retired: false });
						}
						return taken;
					});
				}),
				complete: (key, completion) =>
					armed(() => {
						const running = active.get(key);
						if (running === undefined) throw new Error(`Deadline callback lane ${key} is idle`);
						const callbackAt =
							completion.callbackAtEpochMs != null && Number.isFinite(completion.callbackAtEpochMs)
								? completion.callbackAtEpochMs
								: undefined;
						const announced = held.get(key)?.at;
						const at = completion.mergeAnnouncements
							? callbackAt === undefined
								? announced
								: Math.min(callbackAt, announced ?? Infinity)
							: callbackAt;
						const stale = stopped || running.retired;
						if (!stale) {
							if (at === undefined) held.delete(key);
							else held.set(key, { subject: running.entry.subject, at });
						}
						active.delete(key);
						return { subject: running.entry.subject, at: stale ? undefined : at, stale };
					}),
				armedFor: Effect.sync(() => armedFor)
			};
		})
};

export const inProcessDeadlines = <E, R>(wake: (scope: string) => Effect.Effect<void, E, R>) =>
	Layer.effect(
		DeadlinePort,
		Effect.gen(function* () {
			const answers = new Map<string, number | null>();
			const waking = new Set<string>();
			let timer: DeadlineTimer<string>;
			const onDue = Effect.gen(function* () {
				const entry = yield* timer.takeDue;
				if (entry === undefined) return;
				waking.add(entry.key);
				answers.delete(entry.key);
				const result = yield* Effect.result(
					wake(entry.subject).pipe(Effect.tapCause(Effect.logWarning))
				);
				waking.delete(entry.key);
				const now = yield* Clock.currentTimeMillis;
				yield* timer.complete(entry.key, {
					callbackAtEpochMs: result._tag === 'Success' ? answers.get(entry.key) : now + 60_000,
					mergeAnnouncements: result._tag === 'Success'
				});
				answers.delete(entry.key);
			});
			timer = yield* DeadlineTimer.make<string, R>(onDue);
			return {
				announce: (scope: string, at: string) =>
					timer.announce(scope, scope, Date.parse(at)).pipe(Effect.asVoid),
				settle: (scope: string, at: string | null) =>
					waking.has(scope)
						? Effect.sync(() => {
								answers.set(scope, at === null ? null : Date.parse(at));
							})
						: timer.settle(scope, scope, at === null ? null : Date.parse(at)),
				teardown: (scope: string) => timer.retire(scope).pipe(Effect.asVoid)
			};
		})
	);

export const DeadlinesLive = Layer.effect(
	Deadlines,
	Effect.gen(function* () {
		const port = yield* DeadlinePort;
		const activation = yield* Activation;
		const absent = (effect: Effect.Effect<void, { readonly _tag: 'Unavailable' }>) =>
			effect.pipe(Effect.catchTag('Unavailable', () => Effect.void));
		yield* Effect.addFinalizer(() => absent(port.teardown(activation.scope)));
		return {
			announce: (at: string) => absent(port.announce(activation.scope, at)),
			settle: (at: string | null) => absent(port.settle(activation.scope, at))
		};
	})
);
