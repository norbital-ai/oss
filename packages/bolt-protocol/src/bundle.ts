import { Effect, Predicate, Schema } from 'effect';
import type { FacilityBindings } from './facilities.js';
import type { Activation, Invocation } from './invocation.js';
import { FacilityName, ProtocolVersion, WireError } from './wire.js';

export const StaticAsset = Schema.Struct({
	path: Schema.NonEmptyString,
	contentType: Schema.NonEmptyString,
	sha256: Schema.NonEmptyString,
	bytes: Schema.Uint8Array
});
export interface StaticAsset extends Schema.Schema.Type<typeof StaticAsset> {}

export const RealtimeOutput = Schema.Struct({
	frames: Schema.Array(
		Schema.Struct({
			cursor: Schema.NonEmptyString,
			kind: Schema.Literals(['binary', 'text']),
			bytes: Schema.Uint8Array
		})
	),
	nextCursor: Schema.optionalKey(Schema.String),
	close: Schema.optionalKey(
		Schema.Struct({ code: Schema.Number.check(Schema.isInt()), reason: Schema.String })
	)
}).annotate({ identifier: 'BoltRealtimeOutput' });
export interface RealtimeOutput extends Schema.Schema.Type<typeof RealtimeOutput> {}

const Count = Schema.Number.check(Schema.isInt());

/** Where a source puts the next-page token: a response header, or a place in the body. */
const pageTokenLocations = [
	Schema.Struct({ header: Schema.NonEmptyString }),
	Schema.Struct({ field: Schema.NonEmptyString }),
	Schema.Struct({ path: Schema.Array(Schema.NonEmptyString) })
] as const;
const PageTokenLocation = Schema.Union(pageTokenLocations);

/**
 * Where the resumption point comes from, including the one place a page token cannot come from:
 * `maxOf` is the greatest value of a field across the records just read, so it is a watermark for
 * the *next run* rather than a token that can advance a page within this one.
 */
const CursorLocation = Schema.Union([
	...pageTokenLocations,
	Schema.Struct({ maxOf: Schema.NonEmptyString })
]);

/** How a binding resumes: where the kept cursor is sent, and where the next one is read from. */
export const ManifestPullCursor = Schema.Struct({
	send: Schema.Union([
		Schema.Struct({ query: Schema.NonEmptyString }),
		Schema.Struct({ header: Schema.NonEmptyString })
	]),
	next: CursorLocation
}).annotate({ identifier: 'BoltManifestPullCursor' });
export interface ManifestPullCursor extends Schema.Schema.Type<typeof ManifestPullCursor> {}

/** How the source pages, in the four shapes the pull loop knows how to walk. */
export const ManifestPullPages = Schema.Union([
	Schema.Struct({
		style: Schema.Literal('page'),
		pageQuery: Schema.NonEmptyString,
		sizeQuery: Schema.optionalKey(Schema.NonEmptyString),
		size: Schema.optionalKey(Count),
		firstPage: Schema.optionalKey(Count),
		max: Schema.optionalKey(Count)
	}),
	Schema.Struct({
		style: Schema.Literal('offset'),
		offsetQuery: Schema.NonEmptyString,
		limitQuery: Schema.NonEmptyString,
		size: Count,
		max: Schema.optionalKey(Count)
	}),
	Schema.Struct({
		style: Schema.Literal('cursor'),
		query: Schema.NonEmptyString,
		next: PageTokenLocation,
		max: Schema.optionalKey(Count)
	}),
	Schema.Struct({ style: Schema.Literal('link-header'), max: Schema.optionalKey(Count) })
]);
export type ManifestPullPages = typeof ManifestPullPages.Type;

/**
 * One inbound binding, as a host reads it.
 *
 * This is the declaration half of an authored `+integrations.ts` binding — the half that survives
 * `JSON.stringify`. The other half is a live `Schema.Codec`, an identity closure and an optional
 * mapper, which cannot cross a manifest boundary and stay in the artifact's authored runtime.
 *
 * `schedule` is why this is published at all: without it a pull only ever runs when something
 * enqueues one by hand, and a host has no way to learn that the artifact wanted it run hourly.
 */
export const ManifestIntegrationBinding = Schema.Struct({
	name: Schema.NonEmptyString,
	/** Cron, in the host's scheduler. */
	schedule: Schema.NonEmptyString,
	method: Schema.Literals(['GET', 'POST']),
	path: Schema.NonEmptyString,
	cursor: Schema.optionalKey(ManifestPullCursor),
	pages: Schema.optionalKey(ManifestPullPages),
	/** The collection column the external key lands in — what makes a second run an update. */
	identityColumn: Schema.NonEmptyString
}).annotate({ identifier: 'BoltManifestIntegrationBinding' });
export interface ManifestIntegrationBinding extends Schema.Schema.Type<
	typeof ManifestIntegrationBinding
> {}

/** One integration a tenant runtime offers, named `<collection>.<integration>` as the workspace named it. */
export const ManifestIntegration = Schema.Struct({
	name: Schema.NonEmptyString,
	collection: Schema.NonEmptyString,
	receive: Schema.Array(ManifestIntegrationBinding)
}).annotate({ identifier: 'BoltManifestIntegration' });
export interface ManifestIntegration extends Schema.Schema.Type<typeof ManifestIntegration> {}

/** One ordered DDL statement carried by an immutable Preview. */
export const ManifestSchemaStep = Schema.Struct({
	id: Schema.NonEmptyString,
	sql: Schema.NonEmptyString
}).annotate({ identifier: 'BoltManifestSchemaStep' });
export interface ManifestSchemaStep extends Schema.Schema.Type<typeof ManifestSchemaStep> {}

/**
 * The exact schema plan compiled into an artifact.
 *
 * Studio reads this value from the candidate artifact rather than asking the currently routed
 * runtime what its schema is. That distinction is what makes a pre-release DDL review meaningful:
 * the old release cannot describe the database shape the candidate will apply.
 */
export const ManifestSchemaPlan = Schema.Struct({
	fingerprint: Schema.NonEmptyString,
	steps: Schema.Array(ManifestSchemaStep)
}).annotate({ identifier: 'BoltManifestSchemaPlan' });
export interface ManifestSchemaPlan extends Schema.Schema.Type<typeof ManifestSchemaPlan> {}

export const BundleManifest = Schema.Struct({
	protocolVersion: ProtocolVersion,
	artifactId: Schema.NonEmptyString,
	artifactVersion: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	schemaPlan: ManifestSchemaPlan,
	requiredFacilities: Schema.Array(FacilityName),
	staticAssets: Schema.Array(StaticAsset),
	/**
	 * What this artifact mirrors from the outside world, and when it wants each mirror refreshed.
	 *
	 * A required field, empty for a workspace that declares none, for the same reason
	 * `requiredFacilities` is: a host has to be able to tell "declares no integrations" from "was
	 * built before the manifest carried them", and an optional field cannot say that.
	 */
	integrations: Schema.Array(ManifestIntegration)
}).annotate({ identifier: 'BoltBundleManifest' });
export interface BundleManifest extends Schema.Schema.Type<typeof BundleManifest> {}

export const DispatchResponse = Schema.Struct({
	status: Schema.Number.check(Schema.isInt()),
	headers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	body: Schema.optionalKey(Schema.Uint8Array),
	value: Schema.optionalKey(Schema.Json),
	realtime: Schema.optionalKey(RealtimeOutput)
});
export interface DispatchResponse extends Schema.Schema.Type<typeof DispatchResponse> {}

export const BundleResult = Schema.TaggedUnion({
	Success: { response: DispatchResponse },
	Failure: { error: WireError }
});
export type BundleResult = typeof BundleResult.Type;

/**
 * One durable callback the artifact asks the host to hold on its behalf.
 *
 * A command name, and nothing else. It carried `schedule` and `input` as well, so that a host could
 * *originate* work rather than only route it — and that was the wrong side of the seam. A cron is
 * declared by a release, a release is read by the guest, and a host holding one had to learn cron
 * grammar to act on it. Schedules now live in the tenant's own `bolt_schedule`, where the party that
 * can read the declaration is also the party that acts on it, and the host is told one number
 * instead: the next instant anything is due.
 *
 * So this is back to what a host genuinely needs — where to send work addressed to this release.
 */
export const Registration = Schema.Struct({
	command: Schema.NonEmptyString
}).annotate({ identifier: 'BoltRegistration' });
export interface Registration extends Schema.Schema.Type<typeof Registration> {}

export const ActivationResult = Schema.TaggedUnion({
	Activated: {
		registrations: Schema.Array(Registration),
		/**
		 * When this workspace next has something to do, as the guest computed it while activating.
		 *
		 * `null` for a release that declares no schedule and has nothing queued — which is a real and
		 * common state, and the one where a host must arm no timer at all. That is the whole of what
		 * makes idle cost nothing: no heartbeat, no minimum interval, no liveness probe, and no query
		 * until this instant arrives or a request arrives first.
		 *
		 * It rides the activation answer rather than a message of its own because activation has just
		 * written the schedules and is already holding the connection that knows.
		 */
		nextDueAtEpochMs: Schema.Union([Schema.Number, Schema.Null])
	},
	Failure: { error: WireError }
});
export type ActivationResult = typeof ActivationResult.Type;

export type BoltBundle = Readonly<{
	readonly protocolVersion: ProtocolVersion;
	readonly manifest: BundleManifest;
	readonly dispatch: (
		invocation: Invocation,
		facilities: FacilityBindings,
		signal: AbortSignal
		// repository-health:allow EFF2 -- A dynamically imported bundle crosses an artifact/runtime boundary; both host entrypoints convert this promise into Effect immediately.
	) => Promise<BundleResult>;
	readonly activate: (
		activation: Activation,
		facilities: FacilityBindings,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Activation uses the same dynamically imported artifact boundary and is converted into Effect by the host entrypoint.
	) => Promise<ActivationResult>;
}>;

/** Identifies structural or schema failures while validating a dynamically imported artifact module. */
export class BundleModuleError extends Schema.TaggedError<BundleModuleError>()(
	'BoltProtocol.BundleModuleError',
	{
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {
	readonly category = 'bundle-module' as const;
}

/** Validates the data and callable surface of an unknown dynamic import without a cast. */
export const decodeBoltBundleModule = Effect.fn('BoltProtocol.decodeBoltBundleModule')(function* (
	input: unknown
) {
	if (!Predicate.isObject(input)) {
		return yield* new BundleModuleError({ message: 'Bolt bundle module must be an object' });
	}
	const protocolVersion = yield* Schema.decodeUnknownEffect(ProtocolVersion)(
		input['protocolVersion']
	).pipe(
		Effect.mapError(
			(cause) => new BundleModuleError({ message: 'Unsupported Bolt protocol version', cause })
		)
	);
	const manifest = yield* Schema.decodeUnknownEffect(BundleManifest)(input['manifest']).pipe(
		Effect.mapError(
			(cause) => new BundleModuleError({ message: 'Invalid Bolt bundle manifest', cause })
		)
	);
	const dispatch = input['dispatch'];
	const activate = input['activate'];
	if (typeof dispatch !== 'function' || typeof activate !== 'function') {
		return yield* new BundleModuleError({
			message: 'Bolt bundle module must export dispatch and activate functions'
		});
	}
	const bundle: BoltBundle = {
		protocolVersion,
		manifest,
		dispatch: (invocation, facilities, signal) => dispatch(invocation, facilities, signal),
		activate: (activation, facilities, signal) => activate(activation, facilities, signal)
	};
	return bundle;
});

/** Owns host-side bundle compatibility checks without attaching runtime or business meaning. */
const BundleCompatibility = {
	missingFacilities: (
		manifest: BundleManifest,
		bindings: FacilityBindings
	): ReadonlyArray<FacilityName> =>
		manifest.requiredFacilities.filter((name) => bindings[name] === undefined)
};
export const missingFacilities = BundleCompatibility.missingFacilities;
