import { Schema } from 'effect';

export const PROTOCOL_VERSION = 1 as const;

export const ProtocolVersion = Schema.Literal(PROTOCOL_VERSION);
export type ProtocolVersion = typeof ProtocolVersion.Type;

export const TenantId = Schema.NonEmptyString.pipe(Schema.brand('BoltTenantId'));
export type TenantId = typeof TenantId.Type;

export const EnvironmentName = Schema.NonEmptyString.pipe(Schema.brand('BoltEnvironmentName'));
export type EnvironmentName = typeof EnvironmentName.Type;

export const ReleaseId = Schema.NonEmptyString.pipe(Schema.brand('BoltReleaseId'));
export type ReleaseId = typeof ReleaseId.Type;

export const InvocationId = Schema.NonEmptyString.pipe(Schema.brand('BoltInvocationId'));
export type InvocationId = typeof InvocationId.Type;

export const EffectId = Schema.NonEmptyString.pipe(Schema.brand('BoltEffectId'));
export type EffectId = typeof EffectId.Type;

export const LeaseId = Schema.NonEmptyString.pipe(Schema.brand('BoltLeaseId'));
export type LeaseId = typeof LeaseId.Type;

export const FacilityName = Schema.Literals([
	'database',
	'files',
	'ai',
	'communication',
	'connector',
	'tasks',
	'hostTools',
	'transport',
	'identityHooks'
]);
export type FacilityName = typeof FacilityName.Type;

export const ProviderOutcome = Schema.Literals(['known', 'unknown']);
export type ProviderOutcome = typeof ProviderOutcome.Type;

export const WireError = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	retryable: Schema.Boolean,
	outcome: ProviderOutcome,
	httpStatus: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(400), Schema.isLessThan(600))),
	details: Schema.optionalKey(Schema.Json)
}).annotate({ identifier: 'BoltWireError' });
export interface WireError extends Schema.Schema.Type<typeof WireError> {}

/**
 * Who a facility call is being made for, when anyone is.
 *
 * A facility could previously see the tenant and the environment and nothing finer, so anything
 * scoped to a person — a personal secret, a browser session someone signed in themselves — had no
 * key to be stored under. Every member of a workspace would have shared one.
 *
 * It is asserted by the runtime, never carried in a payload. The runtime is what resolved the
 * request's credential against `bolt_sessions`, so it is the only party that knows this and the only
 * one entitled to say it. A payload-supplied subject is precisely the hole that `secrets.write` and
 * `secrets.status` once had, where naming a user in the request body was enough to read their data.
 *
 * Optional because not every invocation has one: a scheduled task and an activation run for the
 * workspace rather than for a person, and a facility that needs a subject must refuse those rather
 * than invent one.
 */
export const CallSubject = Schema.Struct({
	userId: Schema.NonEmptyString,
	roles: Schema.Array(Schema.String)
}).annotate({ identifier: 'BoltCallSubject' });
export interface CallSubject extends Schema.Schema.Type<typeof CallSubject> {}

export const FacilityCall = Schema.Struct({
	invocationId: InvocationId,
	effectId: EffectId,
	deadlineEpochMs: Schema.Number.check(Schema.isFinite()),
	idempotencyKey: Schema.NonEmptyString,
	subject: Schema.optionalKey(CallSubject)
}).annotate({ identifier: 'BoltFacilityCall' });
export interface FacilityCall extends Schema.Schema.Type<typeof FacilityCall> {}

/** Owns schema and value constructors for the transport-neutral facility result union. */
const FacilityResults = {
	schema: <A extends Schema.Top>(value: A) => Schema.TaggedUnion({ Success: { value }, Failure: { error: WireError } }),
	success: <A>(value: A): FacilityResult<A> => ({ _tag: 'Success', value }),
	failure: (error: WireError): FacilityResult<never> => ({ _tag: 'Failure', error })
};
export const FacilityResult = FacilityResults.schema;

export type FacilityResult<A> = Readonly<
	| { readonly _tag: 'Success'; readonly value: A }
	| { readonly _tag: 'Failure'; readonly error: WireError }
>;

export const WireErrorOptions = Schema.Struct({
	retryable: Schema.optionalKey(Schema.Boolean),
	outcome: Schema.optionalKey(ProviderOutcome),
	httpStatus: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 }))),
	details: Schema.optionalKey(Schema.Json)
});
export interface WireErrorOptions extends Schema.Schema.Type<typeof WireErrorOptions> {}

export const success = FacilityResults.success;
export const failure = FacilityResults.failure;

/** Carries make wire error through the typed src failure channel without losing diagnostic context. */
export const makeWireError = (
	code: string,
	message: string,
	options: WireErrorOptions = {}
): WireError => ({
	code,
	message,
	retryable: options.retryable ?? false,
	outcome: options.outcome ?? 'known',
	...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
	...(options.details === undefined ? {} : { details: options.details })
});
