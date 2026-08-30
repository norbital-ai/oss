import { Context, Effect, Layer, Schema } from 'effect';
import {
	EffectId,
	type DatabaseRequest,
	type EffectId as EffectIdType,
	type HostScheduleDiscoverResponse,
	type HostScheduleOutcome
} from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import type { CallContext } from '#lib/runtime/facilities/database.js';
import { Tasks } from '#lib/runtime/facilities/services.js';
import {
	makeQueue,
	progressStatement,
	recoverStatement,
	statusStatement,
	stopStatement,
	type Declaration,
	type Rejection,
	type Statement
} from '#lib/runtime/tasks/queue.js';

export type Interface = Readonly<{
	/** Host startup hook. Conductor calls this once for each loaded environment after a restart. */
	readonly recover: (effectId: EffectIdType) => Effect.Effect<void, Database.FacilityError>;
	/** Host-local ownership only. None of these operations creates durable execution state. */
	readonly active: (effectId: EffectIdType, taskId: string) => Effect.Effect<void>;
	readonly settled: (effectId: EffectIdType, taskId: string) => Effect.Effect<void>;
	readonly interruptActive: (effectId: EffectIdType, taskId: string) => Effect.Effect<void>;
	readonly wake: (
		effectId: EffectIdType,
		notLaterThanEpochMs: number
	) => Effect.Effect<void, Database.FacilityError>;
	readonly declare: (
		effectId: EffectIdType,
		declarations: ReadonlyArray<Declaration>,
		nowEpochMs: number
	) => Effect.Effect<
		{
			readonly rejections: ReadonlyArray<Rejection>;
			readonly nextDueAtEpochMs: number | undefined;
		},
		Database.FacilityError
	>;
	/** Advances due declarations and returns inert occurrence values for the host to invoke. */
	readonly discover: (
		effectId: EffectIdType,
		nowEpochMs: number
	) => Effect.Effect<HostScheduleDiscoverResponse, Database.FacilityError>;
	/** Settles one exact occurrence from a later, fresh host invocation. */
	readonly settle: (
		effectId: EffectIdType,
		taskId: string,
		outcome: HostScheduleOutcome
	) => Effect.Effect<number | undefined, Database.FacilityError>;
	readonly status: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	readonly progress: (
		effectId: EffectIdType,
		taskId: string,
		value: Schema.Json
	) => Effect.Effect<void, Database.FacilityError>;
	/** Stops one active cron occurrence. It is terminal; there is no resume transition. */
	readonly stop: (
		effectId: EffectIdType,
		taskId: string,
		command: string
	) => Effect.Effect<void, Database.FacilityError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/TaskQueue');

const asRequest = (statements: ReadonlyArray<Statement>): DatabaseRequest => {
	const only = statements.length === 1 ? statements[0] : undefined;
	return only === undefined
		? {
				_tag: 'Transaction',
				statements: statements.map(({ sql, parameters }) => ({ sql, parameters }))
			}
		: { _tag: 'Query', sql: only.sql, parameters: only.parameters };
};

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeDatabaseRows = Schema.decodeUnknownEffect(Schema.Array(JsonObject));

export const layer = (_context: CallContext) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const database = yield* Database.Service;
			const tasks = yield* Tasks.Service;
			const executeUnder = (effectId: EffectIdType, label: string) => {
				let issued = 0;
				return (statements: ReadonlyArray<Statement>) => {
					issued += 1;
					// The mapping covers the decode and nothing else. Wrapping the whole pipeline rewrote
					// the database's own failure into "non-row value" as well, so a genuine SQL error
					// reached activation describing a response shape instead of the statement that broke.
					return database
						.execute(EffectId.make(`${effectId}:${label}:${issued}`), asRequest(statements))
						.pipe(
							Effect.flatMap((response) =>
								decodeDatabaseRows(response.rows).pipe(
									Effect.mapError(
										() =>
											new Database.FacilityError({
												operation: 'tasks',
												code: 'task_observation_invalid_response',
												message: 'Task database query returned a non-row value',
												retryable: false,
												outcome: 'known'
											})
									)
								)
							)
						);
				};
			};
			const wake = Effect.fn('TaskQueue.wake')(function* (
				effectId: EffectIdType,
				notLaterThanEpochMs: number
			) {
				yield* tasks.execute(effectId, { _tag: 'Wake', notLaterThanEpochMs });
			});
			return Service.of({
				recover: Effect.fn('TaskQueue.recover')(function* (effectId) {
					yield* database.execute(effectId, asRequest([recoverStatement()]));
				}),
				active: (effectId, taskId) =>
					Effect.ignore(tasks.execute(effectId, { _tag: 'Active', taskId })),
				settled: (effectId, taskId) =>
					Effect.ignore(tasks.execute(effectId, { _tag: 'Settled', taskId })),
				interruptActive: (effectId, taskId) =>
					Effect.ignore(tasks.execute(effectId, { _tag: 'Interrupt', taskId })),
				wake,
				declare: Effect.fn('TaskQueue.declare')((effectId, declarations, nowEpochMs) =>
					makeQueue(executeUnder(effectId, 'declare')).declare(declarations, nowEpochMs)
				),
				discover: Effect.fn('TaskQueue.discover')(function* (effectId, nowEpochMs) {
					const report = yield* makeQueue(executeUnder(effectId, 'discover')).fire(nowEpochMs);
					return {
						occurrences: report.occurrences,
						rejections: report.rejections.map(({ key, reason }) => ({
							scheduleKey: key,
							reason
						})),
						nextDueAtEpochMs: report.nextDueAtEpochMs ?? null
					};
				}),
				settle: Effect.fn('TaskQueue.settle')(function* (effectId, taskId, outcome) {
					const next = yield* makeQueue(executeUnder(effectId, 'settle')).settle(taskId, outcome);
					return next;
				}),
				status: Effect.fn('TaskQueue.status')(function* (effectId, taskId) {
					const response = yield* database.execute(effectId, asRequest([statusStatement(taskId)]));
					return response.rows[0];
				}),
				progress: Effect.fn('TaskQueue.progress')(function* (effectId, taskId, value) {
					yield* database.execute(effectId, asRequest([progressStatement(taskId, value)]));
				}),
				stop: Effect.fn('TaskQueue.stop')(function* (effectId, taskId, command) {
					yield* database.execute(effectId, asRequest([stopStatement(taskId, command)]));
					yield* tasks.execute(EffectId.make(`${effectId}:interrupt`), {
						_tag: 'Interrupt',
						taskId
					});
				})
			});
		})
	);
