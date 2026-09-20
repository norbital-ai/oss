import { Schema } from 'effect';

export const CommandHeaders = Schema.Record(Schema.String, Schema.Array(Schema.String));

export type CommandResponseContract = Readonly<{
	readonly status: number;
	readonly value: Schema.Top;
	readonly headers: Schema.Top;
}>;

export type CommandContract<Name extends string = string> = Readonly<{
	readonly name: Name;
	readonly input: Schema.Top;
	readonly responses: ReadonlyArray<CommandResponseContract>;
	readonly clientPath?: ReadonlyArray<string>;
	readonly clientMode?: 'operation' | 'query';
	readonly budgetKey?: string;
}>;

export const commandContract = <const Contract extends CommandContract>(
	contract: Contract
): Contract => contract;

/**
 * Where a registration link lands, on every host. A Bolt browser path: the workspace shell renders
 * the claim, so the runtime can mint a working link without knowing which host serves it.
 */
export const ENVOY_REGISTRATION_PATH = '/envoy-registration';
/** Where a workspace invitation link lands, on every host: the shell accepts it for the signed-in person. */
export const INVITATION_PATH = '/invitation';
/**
 * The two request paths that make a workspace an installable app, answered by the runtime on
 * every host. Request-relative like the paths above: a host mounts the request namespace where it
 * likes, and the shell asks for them beneath its own mount. The manifest names the workspace and
 * scopes the install to the mount; the worker is what a push lands in and what answers a
 * navigation with no network. Neither needs a session — a manifest is fetched before one exists.
 */
export const PWA_MANIFEST_PATH = '/manifest.webmanifest';
export const SERVICE_WORKER_PATH = '/sw.js';
/**
 * The host configuration key naming the public URL the workspace shell is served at — origin and
 * mount prefix, e.g. `https://core.example/__bolt`. Registration links are minted beneath it.
 */
export const PUBLIC_WORKSPACE_ROOT_CONFIG_KEY = 'BOLT_PUBLIC_WORKSPACE_ROOT';
export const HOST_RECOVER_COMMAND = 'host.recover';
export const HOST_SCHEDULE_DISCOVER_COMMAND = 'host.schedules.discover';
export const HOST_SCHEDULE_SETTLE_COMMAND = 'host.schedules.settle';

export const HostRecoverRequest = Schema.Struct({}).annotate({
	identifier: 'BoltHostRecoverRequest'
});
export interface HostRecoverRequest extends Schema.Schema.Type<typeof HostRecoverRequest> {}
export const HostRecoverResponse = Schema.Struct({ recovered: Schema.Literal(true) }).annotate({
	identifier: 'BoltHostRecoverResponse'
});
export interface HostRecoverResponse extends Schema.Schema.Type<typeof HostRecoverResponse> {}

export const HostScheduleOccurrence = Schema.Struct({
	/** Stable task identity (cron uses `schedule:<key>@<instant>`). */
	taskId: Schema.NonEmptyString,
	/** Stable work key: the declared schedule key for cron, or `task:<taskId>` for direct work. */
	scheduleKey: Schema.NonEmptyString,
	scheduledForEpochMs: Schema.Number.check(Schema.isInt(), Schema.isFinite()),
	command: Schema.NonEmptyString,
	input: Schema.Json,
	/** One-based durable attempt number assigned by the atomic claim. */
	attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
}).annotate({ identifier: 'BoltHostScheduleOccurrence' });
export interface HostScheduleOccurrence extends Schema.Schema.Type<typeof HostScheduleOccurrence> {}

export const HostScheduleRejection = Schema.Struct({
	scheduleKey: Schema.NonEmptyString,
	reason: Schema.NonEmptyString
}).annotate({ identifier: 'BoltHostScheduleRejection' });
export interface HostScheduleRejection extends Schema.Schema.Type<typeof HostScheduleRejection> {}

export const HostScheduleDiscoverRequest = Schema.Struct({
	nowEpochMs: Schema.Number.check(Schema.isInt(), Schema.isFinite()),
	/**
	 * How long a claim fences the row before an unrenewed lease counts as a dead host.
	 *
	 * It is not the interval a run fits in: an occurrence has no wall, and the guest renews its own
	 * lease while it runs (`Invocation.Task.taskId`). What expiry means is that nobody renewed it.
	 */
	leaseForMillis: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(1_000),
		Schema.isLessThanOrEqualTo(3_600_000)
	)
}).annotate({ identifier: 'BoltHostScheduleDiscoverRequest' });
export interface HostScheduleDiscoverRequest extends Schema.Schema.Type<
	typeof HostScheduleDiscoverRequest
> {}

export const HostScheduleDiscoverResponse = Schema.Struct({
	occurrences: Schema.Array(HostScheduleOccurrence),
	rejections: Schema.Array(HostScheduleRejection),
	nextDueAtEpochMs: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isFinite()))
}).annotate({ identifier: 'BoltHostScheduleDiscoverResponse' });
export interface HostScheduleDiscoverResponse extends Schema.Schema.Type<
	typeof HostScheduleDiscoverResponse
> {}

export const HostScheduleOutcome = Schema.TaggedUnion({
	Done: { result: Schema.Json },
	Failed: { error: Schema.NonEmptyString, retryable: Schema.Boolean },
	Skipped: { reason: Schema.Literal('overlap') }
}).annotate({ identifier: 'BoltHostScheduleOutcome' });
export type HostScheduleOutcome = typeof HostScheduleOutcome.Type;

export const HostScheduleSettleRequest = Schema.Struct({
	occurrence: HostScheduleOccurrence,
	outcome: HostScheduleOutcome
}).annotate({ identifier: 'BoltHostScheduleSettleRequest' });
export interface HostScheduleSettleRequest extends Schema.Schema.Type<
	typeof HostScheduleSettleRequest
> {}

export const HostScheduleSettleResponse = Schema.Struct({
	settled: Schema.Literal(true),
	nextDueAtEpochMs: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isFinite()))
}).annotate({ identifier: 'BoltHostScheduleSettleResponse' });
export interface HostScheduleSettleResponse extends Schema.Schema.Type<
	typeof HostScheduleSettleResponse
> {}

export const HostCommandContracts = [
	commandContract({
		name: HOST_RECOVER_COMMAND,
		input: HostRecoverRequest,
		responses: [{ status: 200, value: HostRecoverResponse, headers: CommandHeaders }]
	}),
	commandContract({
		name: HOST_SCHEDULE_DISCOVER_COMMAND,
		input: HostScheduleDiscoverRequest,
		responses: [{ status: 200, value: HostScheduleDiscoverResponse, headers: CommandHeaders }]
	}),
	commandContract({
		name: HOST_SCHEDULE_SETTLE_COMMAND,
		input: HostScheduleSettleRequest,
		responses: [{ status: 200, value: HostScheduleSettleResponse, headers: CommandHeaders }]
	})
] as const;
