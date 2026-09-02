import { Cause, Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type { AuthoredRefusal, RefusalSite } from '#lib/authoring/refusal.js';
import {
	mutationPhaseFailure,
	type MutationPhaseFailure
} from '#lib/runtime/collections/collections.contract.js';
import type { AppliedDeclarativeGraph } from './engine.js';

type SettleDeclarativeGraphPorts<EmitE = never, EmbedE = never> = Readonly<{
	readonly buildApi: (
		effectId: EffectId,
		subject: Identity.Subject,
		elevated: boolean,
		depth: number
	) => unknown;
	readonly runHook: (
		hook: { readonly handler: (context: unknown) => unknown } | undefined,
		context: unknown,
		site: RefusalSite
	) => Effect.Effect<unknown, AuthoredRefusal>;
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
		limit: number,
		targets: ReadonlyMap<string, ReadonlyArray<string>>
	) => Effect.Effect<unknown, EmbedE, never>;
}>;

/** After-hook, change-event, and embedding settle for one committed graph. */
export const settleDeclarativeGraph = Effect.fn('Collections.settleDeclarativeGraph')(function* <
	EmitE,
	EmbedE
>(
	ports: SettleDeclarativeGraphPorts<EmitE, EmbedE>,
	effectId: EffectId,
	subject: Identity.Subject,
	applied: AppliedDeclarativeGraph,
	hookDepth: number
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
	const runAfterHook = (
		operation: (typeof operations)[number],
		hook: { readonly handler: (context: unknown) => unknown },
		context: (api: unknown) => unknown,
		action: RefusalSite['action']
	) =>
		settleStep(
			'after-hook',
			operation.collection,
			ports.runHook(
				hook,
				context(
					ports.buildApi(operation.taskScope, subject, true, hookDepth + operation.depth + 1)
				),
				{
					collection: operation.collection,
					...(action === undefined ? {} : { action })
				}
			)
		);
	for (const operation of operations) {
		if (operation.action === 'delete') {
			const removed = operation.module?.delete?.perRecord?.after;
			if (removed === undefined) continue;
			yield* runAfterHook(
				operation,
				removed,
				(api) => ({ record: operation.previous, api }),
				'delete.after'
			);
			continue;
		}
		if (
			operation.action === 'update' &&
			Object.keys(operation.values).length === 0 &&
			operation.clearLock !== true
		)
			continue;
		const hook = operation.module?.mutate?.perRecord?.after;
		if (hook === undefined) continue;
		const record = records.get(`${operation.collection}\u0000${operation.id}`);
		if (record === undefined) continue;
		yield* runAfterHook(
			operation,
			hook,
			(api) => ({ previous: operation.previous, changes: operation.values, record, api }),
			'mutate.after'
		);
	}
	for (const [key, grouped] of Map.groupBy(
		operations.filter(
			(operation) =>
				operation.action !== 'update' ||
				Object.keys(operation.values).length > 0 ||
				operation.clearLock === true
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
			ports.embedRecords(
				EffectId.make(`${effectId}:embedding-refresh`),
				[...embeddingTargets.values()].reduce((count, ids) => count + ids.length, 0),
				embeddingTargets
			)
		);
	return records;
});
