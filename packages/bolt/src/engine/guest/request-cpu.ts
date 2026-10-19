import { Context, Effect, Option, Semaphore, type Scope } from 'effect';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';

export interface CpuSource {
	readonly cpu: () => number;
	readonly drop: () => void;
	readonly budget: number;
}

/** CPU is native isolate thread time. The watchdog re-arms against the remaining CPU budget. */
const cpuWall = <A, E, R>(
	work: Effect.Effect<A, E, R>,
	cpu: () => number,
	budget: number,
	drop: () => void,
	over: () => BoltError
) => {
	const monitor = Effect.gen(function* () {
		for (;;) {
			const left = budget - cpu();
			if (left <= 0) {
				drop();
				return yield* Effect.fail(over());
			}
			yield* Effect.sleep(Math.max(1, left));
		}
	});
	return Effect.raceFirst(work, monitor).pipe(
		Effect.tap(() => (cpu() >= budget ? Effect.fail(over()) : Effect.void))
	);
};

interface RequestCpuShape {
	readonly run: <A, E, R>(
		work: Effect.Effect<A, E, R>,
		source: CpuSource,
		compute: Effect.Effect<void, BoltError, Scope.Scope>
	) => Effect.Effect<A, E | BoltError, R>;
}

/** One request's native CPU debit; its gate is never held across a host crossing or provider wait. */
export class RequestCpu extends Context.Service<RequestCpu, RequestCpuShape>()('bolt/RequestCpu') {}

export const makeRequestCpu = (budget: number = LIMITS.guestCpuMs) =>
	Effect.gen(function* () {
		const gate = yield* Semaphore.make(1);
		let used = 0;
		return RequestCpu.of({
			run: (work, source, compute) =>
				gate.withPermit(
					Effect.scoped(
						Effect.gen(function* () {
							if (used >= budget)
								return yield* BoltError.make(
									'cpuBudget',
									'guest',
									`the request used its ${budget} ms of guest CPU`
								);
							yield* compute;
							const start = source.cpu();
							const requestRemaining = budget - used,
								sourceRemaining = source.budget - start,
								remaining = Math.min(requestRemaining, sourceRemaining);
							const over = () =>
								BoltError.make(
									'cpuBudget',
									'guest',
									requestRemaining <= sourceRemaining
										? `the request used its ${budget} ms of guest CPU`
										: `the invocation used its ${source.budget} ms of guest CPU`
								);
							if (remaining <= 0) {
								used = budget;
								return yield* over();
							}
							const elapsed = () => Math.max(0, source.cpu() - start);
							return yield* cpuWall(work, elapsed, remaining, source.drop, over).pipe(
								Effect.tapError((error) =>
									error instanceof BoltError && error.code === 'cpuBudget'
										? Effect.sync(() => {
												used = budget;
											})
										: Effect.void
								),
								Effect.ensuring(
									Effect.sync(() => {
										used = Math.min(budget, used + elapsed());
									})
								)
							);
						})
					)
				)
		});
	});

/** A root HTTP request or independent background job starts a fresh aggregate budget. */
export const withRequestCpu = <A, E, R>(
	work: Effect.Effect<A, E, R>,
	budget: number = LIMITS.guestCpuMs
) => Effect.flatMap(makeRequestCpu(budget), (cpu) => Effect.provideService(work, RequestCpu, cpu));

/** Nested guest invocations retain the current request's budget; direct same-graph callers acquire one once. */
export const ensureRequestCpu = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	Effect.flatMap(
		Effect.serviceOption(RequestCpu),
		Option.match({
			onNone: () => withRequestCpu(work),
			onSome: (cpu) => Effect.provideService(work, RequestCpu, cpu)
		})
	);
