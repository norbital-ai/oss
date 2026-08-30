import { Schema } from 'effect';

export const HOST_RECOVER_COMMAND = 'host.recover';
export const HOST_SCHEDULE_DISCOVER_COMMAND = 'host.schedules.discover';
export const HOST_SCHEDULE_SETTLE_COMMAND = 'host.schedules.settle';
export const HOST_AGENT_EXECUTE_CHILD_COMMAND = 'host.agents.executeChild';

export const HostRecoverRequest = Schema.Struct({}).annotate({
	identifier: 'BoltHostRecoverRequest'
});
export interface HostRecoverRequest extends Schema.Schema.Type<typeof HostRecoverRequest> {}
export const HostRecoverResponse = Schema.Struct({ recovered: Schema.Literal(true) }).annotate({
	identifier: 'BoltHostRecoverResponse'
});
export interface HostRecoverResponse extends Schema.Schema.Type<typeof HostRecoverResponse> {}

export const HostScheduleOccurrence = Schema.Struct({
	/** Stable occurrence identity (`schedule:<key>@<instant>`). */
	taskId: Schema.NonEmptyString,
	/** Host overlap exclusion is keyed by this value within tenant/environment. */
	scheduleKey: Schema.NonEmptyString,
	scheduledForEpochMs: Schema.Number.check(Schema.isInt(), Schema.isFinite()),
	command: Schema.NonEmptyString,
	input: Schema.Json
}).annotate({ identifier: 'BoltHostScheduleOccurrence' });
export interface HostScheduleOccurrence extends Schema.Schema.Type<
	typeof HostScheduleOccurrence
> {}

export const HostScheduleRejection = Schema.Struct({
	scheduleKey: Schema.NonEmptyString,
	reason: Schema.NonEmptyString
}).annotate({ identifier: 'BoltHostScheduleRejection' });
export interface HostScheduleRejection extends Schema.Schema.Type<
	typeof HostScheduleRejection
> {}

export const HostScheduleDiscoverRequest = Schema.Struct({
	nowEpochMs: Schema.Number.check(Schema.isInt(), Schema.isFinite())
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
	Failed: { error: Schema.NonEmptyString },
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

export const HostAgentExecuteChildRequest = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString
}).annotate({ identifier: 'BoltHostAgentExecuteChildRequest' });
export interface HostAgentExecuteChildRequest extends Schema.Schema.Type<
	typeof HostAgentExecuteChildRequest
> {}
