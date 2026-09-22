import { Cause, Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	mutationPhaseFailure,
	type MutationPhaseFailure
} from '#lib/runtime/collections/collections.contract.js';
import type { AppliedDeclarativeGraph } from './engine.js';
import type { EmbedRecordsOptions } from '#lib/runtime/collections/services/embeddings.js';

type SettleDeclarativeGraphPorts<EmitE = never, EmbedE = never> = Readonly<{
	readonly emitChangeEventsMany: (
		effectId: EffectId,
		collection: string,
		records: ReadonlyArray<{
			readonly taskScope: string;
			readonly row: Readonly<Record<string, unknown>>;
		}>,
		event: 'created' | 'updated' | 'deleted'
	) => Effect.Effect<void, EmitE, never>;
	readonly embedRecords: (
		effectId: EffectId,
		options: EmbedRecordsOptions
	) => Effect.Effect<unknown, EmbedE, never>;
}>;

/** Change-event and embedding settle for one committed graph. */
export const settleDeclarativeGraph = Effect.fn('Collections.settleDeclarativeGraph')(function* <
	EmitE,
	EmbedE
>(
	ports: SettleDeclarativeGraphPorts<EmitE, EmbedE>,
	effectId: EffectId,
	applied: AppliedDeclarativeGraph
) {
	const { operations, records } = applied;
	const committed = operations.map((operation) => operation.id);
	const settleStep = <A, E>(
		step: NonNullable<MutationPhaseFailure['step']>,
		collection: string,
		effect: Effect.Effect<A, E>
	) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				Effect.fail(
					mutationPhaseFailure('settle', collection, committed, Cause.squash(cause), step)
				)
			)
		);
	for (const [key, grouped] of Map.groupBy(
		operations.filter(
			(operation) => operation.action !== 'update' || Object.keys(operation.values).length > 0
		),
		(operation) => `${operation.collection}\u0000${operation.action}`
	)) {
		const [collection, action] = key.split('\u0000') as [string, 'create' | 'update' | 'delete'];
		yield* settleStep(
			'change-events',
			collection,
			ports.emitChangeEventsMany(
				effectId,
				collection,
				grouped.flatMap((operation) => {
					const record =
						action === 'delete'
							? operation.previous
							: records.get(`${operation.collection}\u0000${operation.id}`);
					return record === undefined ? [] : [{ taskScope: operation.taskScope, row: record }];
				}),
				action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted'
			)
		);
	}
	const embeddingTargets = new Map<string, Array<string>>();
	for (const operation of operations) {
		if (operation.action === 'delete' || operation.definition.embedding === undefined) continue;
		const ids = embeddingTargets.get(operation.collection) ?? [];
		ids.push(operation.id);
		embeddingTargets.set(operation.collection, ids);
	}
	if (embeddingTargets.size > 0)
		yield* settleStep(
			'embedding-refresh',
			[...embeddingTargets.keys()].join(','),
			ports.embedRecords(EffectId.make(`${effectId}:embedding-refresh`), {
				limit: [...embeddingTargets.values()].reduce((count, ids) => count + ids.length, 0),
				targets: embeddingTargets
			})
		);
	return records;
});
