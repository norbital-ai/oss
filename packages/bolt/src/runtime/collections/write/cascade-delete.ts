/**
 * Cascading delete preparation.
 *
 * Deleting an owned row necessarily deletes the rows it owns. Every descendant is planned through the
 * same authorization, approval, hooks, history, sync and event pipeline as its parent, before the
 * database's foreign-key cascade could make it disappear invisibly. The child collection's delete
 * hooks run once per wave over all related rows; each row is then prepared with that wave's result.
 */
import { Effect } from 'effect';
import type { AuthoredRefusal } from '#lib/authoring/refusal.js';
import type { GraphPrepareFns, GraphPreparePorts } from './engine.js';
import { ownsManyRelation } from './plan.js';

export const prepareOwnedDescendants = <Error, Requirements>(
	ports: GraphPreparePorts<Error, Requirements>,
	prepareDelete: GraphPrepareFns<Error | AuthoredRefusal, Requirements>['prepareDelete'],
	collection: string,
	id: string,
	depth: number
): Effect.Effect<void, Error | AuthoredRefusal, Requirements> =>
	Effect.gen(function* () {
		for (const relation of ports.workspace.definition.relations) {
			if (relation.source !== collection || relation.cardinality !== 'many') continue;
			const edge = ports.resolveWritableManyRelation(
				ports.workspace.definition,
				collection,
				relation.name
			);
			if (edge === undefined || !ownsManyRelation(edge)) continue;
			const related = yield* ports.relatedRows(ports.scope(), edge, id);
			ports.registerRelationshipSnapshot(edge, id, related.json);
			const childModule = ports.authoredHooks[edge.childCollection];
			const childPrepared = yield* ports.runDeletePrepare(
				ports.effectId,
				ports.subject,
				edge.childCollection,
				related.rows,
				childModule,
				ports.hookDepth + depth + 1,
				ports.stageHookWrites
			);
			for (const child of related.rows)
				yield* prepareDelete(edge.childCollection, child, depth + 1, false, childPrepared);
		}
	});
