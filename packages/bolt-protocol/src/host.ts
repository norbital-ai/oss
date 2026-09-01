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
	/** Host-owned dispatch deadline; the claim lease covers this complete interval. */
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
