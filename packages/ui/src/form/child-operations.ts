import type { Value } from '@norbital-ai/std/kind';
import type { Values } from '../model/types.js';

/** Explicit native commands only: an absent or unloaded row never means delete. */
export type ChildOperation = (
	| { action: 'create'; values: Values }
	| { action: 'update'; id: string; revision: number; set: Values }
	| { action: 'delete' | 'link' | 'unlink'; id: string; revision: number }
) & { proposal?: true };

export function childOperations(commands: Readonly<Record<string, readonly ChildOperation[]>>): {
	set: Record<string, Value>;
	observed: Record<string, number>;
} {
	const set: Record<string, Value> = {},
		observed: Record<string, number> = {};
	for (const [relation, operations] of Object.entries(commands)) {
		const actions: Record<string, Value[]> = {};
		for (const operation of operations) {
			const value =
				operation.action === 'create'
					? operation.values
					: operation.action === 'update'
						? { target: operation.id, set: operation.set }
						: operation.id;
			(actions[operation.action] ??= []).push(value);
			if (operation.action !== 'create') {
				if (!Number.isSafeInteger(operation.revision) || operation.revision < 1)
					throw new Error('A child operation needs its original revision.');
				if (observed[operation.id] !== undefined && observed[operation.id] !== operation.revision)
					throw new Error('A child has inconsistent observed revisions.');
				observed[operation.id] = operation.revision;
			}
		}
		if (Object.keys(actions).length > 0) set[relation] = actions;
	}
	return { set, observed };
}
