import {
	BundleResult,
	HOST_SCHEDULE_DISCOVER_COMMAND,
	HOST_SCHEDULE_SETTLE_COMMAND,
	HostScheduleDiscoverResponse,
	HostScheduleOccurrence,
	HostScheduleOutcome,
	HostScheduleSettleResponse,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	TaskRequest,
	TaskResponse,
	type FacilityBinding,
	type InvocationScope
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, Option, Redacted, Schema } from 'effect';
import { makeWireBinding } from './config.js';
import { systemCommandHeaders } from './system-headers.js';
import type { Timekeeper } from './timekeeper.js';

/**
 * One tick of the tenant's own scheduler, driven the way the guest expects to be driven.
 *
 * The queue is not a command this host may call. It is a *conversation*:
 * `host.schedules.discover` rolls the declarations forward and hands back inert occurrences,
 * the host invokes each occurrence's command itself, and `host.schedules.settle` records what
 * happened. The guest owns cron grammar, attempts, backoff and visibility; this side owns only the
 * clock and the invocations, which is the same division Colony's Timekeeper works under and the
 * reason both hosts can run the same bundle.
 *
 * The two `host.*` calls are `Command` invocations signed with the gateway secret, because that is
 * the only thing that mints a system principal and they are reachable by nothing else. The
 * occurrences are `Task` invocations, deliberately: a `Task` carries no credential, so the runtime's
 * own enqueue gate decides what may run, and a host minting a tenant session to talk to its own
 * tenant would be a standing key to tenant data.
 */

/**
 * The two schema-derived shapes this module carries, named the way the guest's own decoder names
 * them so an occurrence and its outcome can ride a `Schema.Json` invocation input unchanged.
 */
type ScheduleOccurrence = Schema.Schema.Type<typeof HostScheduleOccurrence>;
type ScheduleOutcome = Schema.Schema.Type<typeof HostScheduleOutcome>;

/** Process-local pointers from durable task ids to the dispatch currently serving them. */
export type TaskInvocationControl = Readonly<{
	readonly open: (invocationId: InvocationId) => AbortController;
	readonly close: (invocationId: InvocationId, controller: AbortController) => void;
	readonly active: (taskId: string, invocationId: InvocationId) => void;
	readonly settled: (taskId: string, invocationId: InvocationId) => void;
	readonly interrupt: (taskId: string) => void;
}>;

/** Makes the task-to-dispatch control table used by schedule dispatch and task interruption. */
export const makeTaskInvocationControl = (): TaskInvocationControl => {
	const invocations = new Map<string, AbortController>();
	const tasks = new Map<string, string>();
	return {
		open: (invocationId) => {
			const controller = new AbortController();
			invocations.set(String(invocationId), controller);
			return controller;
		},
		close: (invocationId, controller) => {
			const key = String(invocationId);
			if (invocations.get(key) !== controller) return;
			invocations.delete(key);
			for (const [taskId, activeInvocation] of tasks) {
				if (activeInvocation === key) tasks.delete(taskId);
			}
		},
		active: (taskId, invocationId) => {
			const key = String(invocationId);
			if (invocations.has(key)) tasks.set(taskId, key);
		},
		settled: (taskId, invocationId) => {
			if (tasks.get(taskId) === String(invocationId)) tasks.delete(taskId);
		},
		interrupt: (taskId) => {
			const invocationId = tasks.get(taskId);
			if (invocationId === undefined) return;
			invocations.get(invocationId)?.abort(new Error(`task ${taskId} interrupted`));
		}
	};
};

/** Binds guest task lifecycle messages to the host timer and active dispatch table. */
export const makeTaskBinding = (
	timekeeper: Timekeeper,
	register: (command: string) => void = () => {},
	invocations?: TaskInvocationControl
): FacilityBinding<TaskRequest, TaskResponse> =>
	makeWireBinding({
		request: TaskRequest,
		response: TaskResponse,
		cancelled: { code: 'tasks.cancelled', message: 'Task call was cancelled' },
		failed: { code: 'tasks.failed', message: 'Task facility call failed' },
		invoke: (metadata, input) =>
			Effect.runPromise(
				Effect.sync(() => {
					switch (input._tag) {
						case 'Register':
							register(input.command);
							break;
						case 'Wake':
							timekeeper.announce(input.notLaterThanEpochMs);
							break;
						case 'Active':
							invocations?.active(input.taskId, metadata.invocationId);
							break;
						case 'Settled':
							invocations?.settled(input.taskId, metadata.invocationId);
							break;
						case 'Interrupt':
							invocations?.interrupt(input.taskId);
					}
					return TaskResponse.make({});
				})
			)
	});

/** Identifies the scheduler phase that could not complete, so a failed tick says which half broke. */
export class ScheduleTickError extends Schema.TaggedError<ScheduleTickError>()(
	'BoltServer.ScheduleTickError',
	{
		operation: Schema.String,
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

export type ScheduleTickOptions = Readonly<{
	readonly scope: InvocationScope;
	/** The deadline this host grants one invocation, applied to each dispatch the tick makes. */
	readonly deadlineMillis: number;
	/** Absent on a host that configured no gateway secret, which refuses rather than runs unsigned. */
	readonly gatewaySecret: Redacted.Redacted<string> | undefined;
	/** So an `Interrupt` arriving in another invocation can abort the exact occurrence dispatch. */
	readonly invocations: TaskInvocationControl;
	// repository-health:allow EFF2 -- The bundle's own dispatch is a protocol-owned Promise boundary.
	readonly dispatch: (invocation: Invocation, signal: AbortSignal) => Promise<unknown>;
}>;

/**
 * The headers that make one invocation run as the system principal.
 *
 * The payload comes from the protocol package's `systemSignaturePayload` rather than a rendering
 * kept here: the runtime rebuilds it from what arrived and compares, and two renderings of "the
 * bytes we sign" is how such a check comes to pass on something nobody meant to authorize.
 *
 * A host with no secret fails here rather than dispatching unsigned. An unsigned `host.*` command is
 * refused by the runtime for want of a credential, which would report a missing environment variable
 * as an authorization failure and send an operator to look at the wrong thing.
 */
const systemHeaders = (
	options: ScheduleTickOptions,
	command: string,
	input: Schema.Json
): Effect.Effect<Record<string, Array<string>>, ScheduleTickError> =>
	systemCommandHeaders(options.gatewaySecret, command, options.scope.tenantId, input).pipe(
		Effect.mapError(
			(error) =>
				new ScheduleTickError({
					operation: error.operation,
					message: `${error.message} and no scheduled work can run`
				})
		)
	);

/**
 * One dispatch into the bundle, bounded by this host's invocation deadline.
 *
 * The abort signal is the union of the caller's and this dispatch's own controller, so a task that
 * asks to be interrupted stops here and not only in the tenant's table.
 */
const dispatchOnce = (
	options: ScheduleTickOptions,
	invocation: Invocation,
	invocationId: InvocationId,
	operation: string
): Effect.Effect<BundleResult, ScheduleTickError> =>
	Effect.tryPromise({
		try: (signal) => {
			const controller = options.invocations.open(invocationId);
			return options
				.dispatch(invocation, AbortSignal.any([signal, controller.signal]))
				.finally(() => options.invocations.close(invocationId, controller));
		},
		catch: (cause) =>
			new ScheduleTickError({
				operation,
				message: 'Bolt bundle dispatch failed',
				cause
			})
	}).pipe(
		Effect.timeout(options.deadlineMillis),
		Effect.mapError((cause) =>
			cause instanceof ScheduleTickError
				? cause
				: new ScheduleTickError({
						operation,
						message: 'Bolt bundle did not answer within the invocation deadline',
						cause
					})
		),
		Effect.flatMap((value) =>
			Schema.decodeUnknownEffect(BundleResult)(value).pipe(
				Effect.mapError(
					(cause) =>
						new ScheduleTickError({
							operation,
							message: 'Bolt bundle returned an invalid dispatch result',
							cause
						})
				)
			)
		)
	);

/** One signed `host.*` command, answered with its response value or a failure naming the command. */
const systemCommand = (
	options: ScheduleTickOptions,
	command: string,
	invocationId: InvocationId,
	input: Schema.Json,
	nowEpochMs: number
): Effect.Effect<Schema.Json, ScheduleTickError> =>
	Effect.gen(function* () {
		const headers = yield* systemHeaders(options, command, input);
		const result = yield* dispatchOnce(
			options,
			Invocation.cases.Command.make({
				protocolVersion: PROTOCOL_VERSION,
				id: invocationId,
				scope: options.scope,
				deadlineEpochMs: nowEpochMs + options.deadlineMillis,
				command,
				input,
				headers
			}),
			invocationId,
			command
		);
		if (result._tag !== 'Success') {
			return yield* new ScheduleTickError({
				operation: command,
				message: `Bolt bundle refused ${command}: ${result.error.message}`
			});
		}
		if (result.response.status < 200 || result.response.status >= 300) {
			return yield* new ScheduleTickError({
				operation: command,
				message: `Bolt bundle answered ${command} with status ${result.response.status}`
			});
		}
		return result.response.value ?? null;
	});

/**
 * What one occurrence's dispatch is reported back to the queue as.
 *
 * A refusal is an outcome rather than a tick failure: the task ran and did not succeed, which is a
 * fact the guest records and applies its own attempt policy to. Only the host's own inability to
 * hold the conversation fails the tick.
 */
const occurrenceOutcome = (result: BundleResult): ScheduleOutcome =>
	result._tag !== 'Success'
		? { _tag: 'Failed', error: result.error.message, retryable: result.error.retryable }
		: result.response.status >= 200 && result.response.status < 300
			? { _tag: 'Done', result: result.response.value ?? null }
			: {
					_tag: 'Failed',
					error: `status ${result.response.status}`,
					retryable:
						result.response.status === 408 ||
						result.response.status === 429 ||
						result.response.status >= 500
				};

const invokeOccurrence = (
	options: ScheduleTickOptions,
	nowEpochMs: number,
	occurrence: ScheduleOccurrence
): Effect.Effect<ScheduleOutcome> => {
	const invocationId = InvocationId.make(`task:${occurrence.taskId}:${nowEpochMs}`);
	return dispatchOnce(
		options,
		Invocation.cases.Task.make({
			protocolVersion: PROTOCOL_VERSION,
			id: invocationId,
			scope: options.scope,
			deadlineEpochMs: nowEpochMs + options.deadlineMillis,
			command: occurrence.command,
			input: occurrence.input,
			attempt: occurrence.attempt
		}),
		invocationId,
		occurrence.command
	).pipe(
		Effect.map(occurrenceOutcome),
		Effect.catch((failure) =>
			Effect.succeed<ScheduleOutcome>({
				_tag: 'Failed',
				error: failure.message,
				retryable: true
			})
		)
	);
};

/**
 * Discovers what is due, runs it, records it, and answers when anything is next due.
 *
 * The answer is what the timekeeper arms its one timer to, so `null` genuinely means "nothing", and
 * an idle workspace costs nothing until something announces. A settle that answers `null` does not
 * erase an instant discovery already reported: the conservative direction is one harmless extra
 * tick, never a missed one.
 */
export const runScheduleTick = (
	options: ScheduleTickOptions
): Effect.Effect<number | null, ScheduleTickError> =>
	Effect.gen(function* () {
		const nowEpochMs = yield* Clock.currentTimeMillis;
		const answer = yield* systemCommand(
			options,
			HOST_SCHEDULE_DISCOVER_COMMAND,
			InvocationId.make(`${HOST_SCHEDULE_DISCOVER_COMMAND}:${nowEpochMs}`),
			{ nowEpochMs, leaseForMillis: options.deadlineMillis },
			nowEpochMs
		);
		const discovered = yield* Schema.decodeUnknownEffect(HostScheduleDiscoverResponse)(answer).pipe(
			Effect.mapError(
				(cause) =>
					new ScheduleTickError({
						operation: HOST_SCHEDULE_DISCOVER_COMMAND,
						message: 'Bolt bundle returned a malformed discovery answer',
						cause
					})
			)
		);
		if (discovered.occurrences.length === 0) {
			// A rejection is a schedule the guest could not roll. Nothing is due, so there is nothing to
			// run — but arming to the answer would retry it as fast as the instant comes round, and the
			// host's own backoff is what puts a gap in front of a workspace whose declaration is broken.
			if (discovered.rejections.length > 0) {
				return yield* new ScheduleTickError({
					operation: HOST_SCHEDULE_DISCOVER_COMMAND,
					message: `Bolt bundle rejected ${discovered.rejections.length} schedules: ${discovered.rejections
						.map((rejection) => `${rejection.scheduleKey} (${rejection.reason})`)
						.join(', ')}`
				});
			}
			return discovered.nextDueAtEpochMs;
		}
		let nextDueAtEpochMs: number | null = discovered.nextDueAtEpochMs;
		let settledCount = 0;
		for (const occurrence of discovered.occurrences) {
			const outcome = yield* invokeOccurrence(options, nowEpochMs, occurrence);
			const settled = yield* systemCommand(
				options,
				HOST_SCHEDULE_SETTLE_COMMAND,
				InvocationId.make(`${HOST_SCHEDULE_SETTLE_COMMAND}:${occurrence.taskId}:${nowEpochMs}`),
				{ occurrence, outcome },
				nowEpochMs
			).pipe(
				Effect.flatMap((value) => Schema.decodeUnknownEffect(HostScheduleSettleResponse)(value)),
				Effect.option
			);
			if (Option.isNone(settled)) continue;
			settledCount += 1;
			if (settled.value.nextDueAtEpochMs !== null)
				nextDueAtEpochMs = settled.value.nextDueAtEpochMs;
		}
		if (settledCount !== discovered.occurrences.length) {
			// The occurrences ran; what was lost is the record of how they ended, which the guest's own
			// visibility deadline recovers. The tick still fails, so this host backs off instead of
			// discovering the same unsettled work again immediately.
			return yield* new ScheduleTickError({
				operation: HOST_SCHEDULE_SETTLE_COMMAND,
				message: `Bolt bundle settled ${settledCount}/${discovered.occurrences.length} occurrences`
			});
		}
		return nextDueAtEpochMs;
	});
