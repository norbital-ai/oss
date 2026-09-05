import { Context, Effect, Layer, Option, Schema } from 'effect';
import type {
	DatabaseRequest,
	DatabaseResponse,
	EffectId,
	FacilityBinding,
	FacilityCall,
	InvocationId,
	ProviderOutcome
} from '@norbital-ai/bolt-protocol';
import { describeCause } from '#lib/runtime/workspace.js';
import { currentSubject } from '#lib/runtime/identity/subject.js';

/** Carries facility error through the typed facilities failure channel without losing diagnostic context. */
export class FacilityError extends Schema.TaggedError<FacilityError>()('Bolt.FacilityError', {
	operation: Schema.NonEmptyString,
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	retryable: Schema.Boolean,
	outcome: Schema.Literals(['known', 'unknown'])
}) {}

export type CallContext = Readonly<{
	readonly invocationId: InvocationId;
	readonly deadlineEpochMs: number;
	/**
	 * The deployment environment this invocation was made against, as the host named it.
	 *
	 * Bolt reads no environment variables and has no idea whether it is running on a laptop or in
	 * production. What it does have is the environment the host scoped the invocation to, which is
	 * already part of the protocol — so anything mode-dependent inside the bundle reads it from here
	 * rather than inventing its own notion of a mode.
	 */
	readonly environment: string;
	/**
	 * Which tenant this invocation is for, as the host scoped it — never as a payload claimed it.
	 *
	 * Carried here because it is the one fact a *static* identity has to be minted with and has no row
	 * to read off: a person's subject gets its tenant from the credential that authenticated them, and
	 * an envoy or an automation is declared in source. `TenantScope` publishes it as a service so the
	 * services that mint those subjects read it from the invocation rather than from a workspace name.
	 */
	readonly tenantId: string;
}>;

/** Owns invoke binding behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
export const invokeBinding = <Input, Output>(
	operation: string,
	binding: FacilityBinding<Input, Output> | undefined,
	context: CallContext,
	effectId: EffectId,
	input: Input,
	onProgress?: (event: Schema.Json, signal: AbortSignal) => Promise<void>
): Effect.Effect<Output, FacilityError> =>
	Effect.gen(function* () {
		if (binding === undefined) {
			return yield* new FacilityError({
				operation,
				code: 'facility_unavailable',
				message: `${operation} facility is not bound`,
				retryable: false,
				outcome: 'known'
			});
		}
		// Read from the Effect context rather than passed down: the subject is only known once
		// dispatch has authenticated, which happens after the call context is built. `serviceOption`
		// is what makes a task or an activation — work with no person behind it — carry no subject
		// instead of a fabricated one.
		const subject = yield* currentSubject;
		const metadata: FacilityCall = {
			invocationId: context.invocationId,
			effectId,
			deadlineEpochMs: context.deadlineEpochMs,
			idempotencyKey: effectId,
			...(Option.isSome(subject)
				? {
						subject:
							subject.value.teamPath[0] === undefined
								? { userId: subject.value.userId }
								: { userId: subject.value.userId, team: subject.value.teamPath[0] }
					}
				: {})
		};
		const result = yield* Effect.tryPromise({
			try: (signal) =>
				binding.call(
					metadata,
					input,
					signal,
					onProgress === undefined
						? undefined
						: (event) => {
								signal.throwIfAborted();
								return onProgress(event, signal);
							}
				),
			catch: (cause) =>
				new FacilityError({
					operation,
					code: 'transport_failure',
					message: describeCause(cause),
					retryable: true,
					outcome: 'unknown'
				})
		});
		if (result._tag === 'Failure') {
			return yield* new FacilityError({ operation, ...result.error });
		}
		return result.value;
	});

export type Interface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: DatabaseRequest
	) => Effect.Effect<DatabaseResponse, FacilityError>;
}>;

/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Database');

/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
export const layer = (
	binding: FacilityBinding<DatabaseRequest, DatabaseResponse> | undefined,
	context: CallContext
) =>
	Layer.succeed(
		Service,
		Service.of({
			execute: Effect.fn('Database.execute')((effectId, request) =>
				invokeBinding('database', binding, context, effectId, request)
			)
		})
	);

export type { ProviderOutcome };
