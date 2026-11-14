import { Effect, Layer } from 'effect';
import { DeadlinePort } from '../ports.ts';
import { scope_deadlines, type PortFailure } from '@norbital-ai/host-api';
import { Activation, Deadlines } from '../services.ts';

export const in_process_deadlines = <E, R>(callbacks: {
	readonly wake: (scope: string) => Effect.Effect<void, E, R>;
	readonly pulse: (scope: string) => Effect.Effect<boolean, E, R>;
}) => Layer.effect(DeadlinePort, scope_deadlines(callbacks));

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
