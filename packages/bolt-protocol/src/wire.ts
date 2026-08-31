import { Schema } from 'effect';

/**
 * The wire both hosts and every bundle agree on, as a single literal a mismatch is refused against.
 *
 * Bumped to 6 when AI content gained the provider-neutral `image_asset` part. A version-5 host
 * would forward that part without resolving its tenant-scoped object key, so a vision turn would
 * either fail at the provider or answer without the photograph. Version 6 requires the host to
 * replace every asset part with the corresponding data URL after the bounded isolate crossing.
 *
 * Bumped to 5 when browser collection mutations became server-authoritative exactly-once commands:
 * every request now carries an explicit action, durable idempotency key, issue time, and a base row
 * version for update/delete. A version-4 client can send an unversioned write the version-5 runtime
 * must refuse, while a version-4 runtime would ignore none of the new safety contract reliably.
 *
 * Bumped to 4 when the artifact stopped carrying its own bytes. `staticAssets`, whose every entry
 * held a `Uint8Array` decoded from base64 in the bundle's own source, is replaced by `browserAssets`
 * and `serverAssets` — indexes of digests, with the bytes in flat sidecar files beside the bundle.
 * A version-3 host given a version-4 release would find no assets at all and serve a workspace with
 * no client; a version-4 host given a version-3 release would find the fields absent. Neither
 * composes, so neither is allowed to try.
 *
 * Bumped to 3 when the timer facility also became the ephemeral control seam for the exact task
 * invocation currently running. `Active`, `Settled`, and `Interrupt` carry task ids only; durable
 * queue state remains in the tenant database and the host still owns no second queue.
 *
 * Version 2 was introduced when `TaskRequest` stopped being a queue API and became a timer API: `Enqueue`,
 * `Schedule`, `Cancel` and `Signal` were deleted, `Register` lost `schedule` and `input`, and `Wake`
 * arrived. That is a *shrinking* change, so an old host and a new bundle do not compose in either
 * direction — the old host waits for enqueues that will never arrive, and the new bundle asks for a
 * wake the old host cannot read. Nothing here is negotiated per field, deliberately: one literal
 * means a version mismatch is a refusal at the door rather than a capability discovered halfway
 * through an invocation.
 */
export const PROTOCOL_VERSION = 7 as const;

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

export const FacilityName = Schema.Literals([
	'database',
	'files',
	'ai',
	'communication',
	'connector',
	'tasks',
	'hostTools',
	'transport',
	'identityHooks',
	'config'
]);
export type FacilityName = typeof FacilityName.Type;

export const ProviderOutcome = Schema.Literals(['known', 'unknown']);
export type ProviderOutcome = typeof ProviderOutcome.Type;

export const WireError = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	retryable: Schema.Boolean,
	outcome: ProviderOutcome,
	httpStatus: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(400), Schema.isLessThan(600))
	),
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
	/**
	 * The one team this person belongs to, absent for nobody.
	 *
	 * Replaces a `roles` array. What a team entitles its members to is declared in the workspace's
	 * `+teams.ts` and compiled into the release — so it is the release's business, and a facility
	 * binding has no use for a list of policy names it cannot interpret.
	 */
	team: Schema.optionalKey(Schema.NonEmptyString)
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
	schema: <A extends Schema.Top>(value: A) =>
		Schema.TaggedUnion({ Success: { value }, Failure: { error: WireError } }),
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
	httpStatus: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 }))
	),
	details: Schema.optionalKey(Schema.Json)
});
export interface WireErrorOptions extends Schema.Schema.Type<typeof WireErrorOptions> {}

export const success = FacilityResults.success;
export const failure = FacilityResults.failure;

/** Carries make wire error through the typed src failure channel without losing diagnostic context. */
const decodeWireError = Schema.decodeUnknownSync(WireError);

export const makeWireError = (
	code: string,
	message: string,
	options: WireErrorOptions = {}
): WireError =>
	decodeWireError({
		code,
		message,
		retryable: options.retryable ?? false,
		outcome: options.outcome ?? 'known',
		...options
	});
