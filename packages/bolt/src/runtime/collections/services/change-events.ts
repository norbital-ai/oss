import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type * as Automations from '#lib/runtime/automations/automations.js';

type ChangeEvent = 'created' | 'updated' | 'deleted';

type ChangeEventRecord = Readonly<{
	readonly taskScope: string;
	readonly row: Readonly<Record<string, unknown>>;
}>;

type ChangeTrigger = Readonly<{
	readonly name: string;
	readonly trigger: Readonly<{
		readonly _tag: string;
		readonly collection?: string;
		readonly event?: string;
	}>;
}>;

export type ChangeEventPorts = Readonly<{
	readonly automations: Pick<Automations.Interface, 'startMany' | 'executeMany'>;
	readonly authored: Readonly<Record<string, ChangeTrigger>>;
	readonly runBody: (
		name: string,
		taskId: string,
		raw: Schema.Json,
		attemptEffectId: string
	) => Effect.Effect<Schema.Json, unknown>;
}>;

/**
 * One batch start of every change-triggered automation for the records that exist.
 *
 * A row that was never written is not passed in at all — a change event announces a record.
 */
export const emitChangeEventsMany = Effect.fn('Collections.emitChangeEventsMany')(function* (
	ports: ChangeEventPorts,
	effectId: EffectId,
	collection: string,
	records: ReadonlyArray<ChangeEventRecord>,
	event: ChangeEvent
) {
	if (records.length === 0) return;
	const triggers = Object.values(ports.authored).filter(
		(automation) =>
			automation.trigger._tag === 'Change' &&
			automation.trigger.collection === collection &&
			automation.trigger.event === event
	);
	if (triggers.length === 0) return;
	const runs = triggers.flatMap((automation) =>
		records.map((record) => {
			const taskId = `${record.taskScope}:event:${automation.name}`;
			const scope: Readonly<Record<string, Schema.Json>> =
				event === 'deleted' ? {} : { incoming_record: record.row as Schema.Json };
			return { automation, taskId, scope };
		})
	);
	const admitted = yield* ports.automations.startMany(
		effectId,
		runs.map(({ automation, taskId, scope }) => ({
			effectId: EffectId.make(taskId),
			name: automation.name,
			input: {},
			options: { taskId, scope }
		}))
	);
	yield* ports.automations
		.executeMany(
			EffectId.make(`${effectId}:execute`),
			admitted,
			(name, taskId, raw, attemptEffectId) => ports.runBody(name, taskId, raw, attemptEffectId)
		)
		.pipe(Effect.ignore);
});
