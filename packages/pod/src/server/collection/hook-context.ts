import type { AnyCollectionBehavior } from '$lib/authoring/schema/collection-behavior.js';
import type { CollectionHookParams } from '$lib/authoring/automations/hooks.js';
import { collectionHooks } from './workspace-collections.js';

/** Hook payload fields produced by `adaptHookContextForAction` (api is supplied by dispatch). */
export type ErasedHookActionContext =
	| { readonly input: Record<string, unknown> }
	| { readonly record: Record<string, unknown> }
	| { readonly input: Record<string, unknown>; readonly existing: Record<string, unknown> }
	| { readonly existing: Record<string, unknown> };

export function hookKeyToActionPhase(
	hookKey: string
): { readonly action: 'create' | 'update' | 'delete'; readonly phase: 'before' | 'after' } | null {
	switch (hookKey) {
		case 'beforeCreate':
			return { action: 'create', phase: 'before' };
		case 'afterCreate':
			return { action: 'create', phase: 'after' };
		case 'beforeUpdate':
			return { action: 'update', phase: 'before' };
		case 'afterUpdate':
			return { action: 'update', phase: 'after' };
		case 'beforeDelete':
			return { action: 'delete', phase: 'before' };
		case 'afterDelete':
			return { action: 'delete', phase: 'after' };
		default:
			return null;
	}
}

export function adaptHookContextForAction(
	hookKey: string,
	context: CollectionHookParams
): ErasedHookActionContext | CollectionHookParams {
	const mapping = hookKeyToActionPhase(hookKey);
	if (!mapping) return context;

	switch (mapping.action) {
		case 'create': {
			if (context.type !== 'create') return context;
			if (mapping.phase === 'before') {
				return { input: context.scope.incoming_record };
			}
			return { record: context.payload };
		}
		case 'update': {
			if (context.type !== 'update') return context;
			if (mapping.phase === 'before') {
				return { input: context.payload, existing: context.scope.original_record };
			}
			return { record: context.payload };
		}
		case 'delete': {
			if (context.type !== 'delete') return context;
			if (mapping.phase === 'before') {
				return { existing: context.scope.original_record };
			}
			return { record: context.scope.original_record };
		}
		default:
			mapping.action satisfies never;
			return context;
	}
}

/**
 * The hooks a collection declares, each with the sentence its author wrote about it.
 *
 * The description is read from the section rather than from the handler because dispatch is given a
 * plain function — `buildMutationSection` splits the authored `{ description, handler }` so no
 * mutation path carries a wrapper it never reads.
 */
export function hooksDeclaredFromBehavior(
	behavior: AnyCollectionBehavior | undefined
): Record<string, { readonly description: string }> {
	const hooks: Record<string, { readonly description: string }> = {};
	if (!behavior) return hooks;
	for (const [action, keys] of [
		['create', { before: 'beforeCreate', after: 'afterCreate' }],
		['update', { before: 'beforeUpdate', after: 'afterUpdate' }],
		['delete', { before: 'beforeDelete', after: 'afterDelete' }]
	] as const) {
		const bundle = collectionHooks(behavior, action);
		const descriptions = behavior[action]?.descriptions;
		if (bundle?.before) hooks[keys.before] = { description: descriptions?.before ?? '' };
		if (bundle?.after) hooks[keys.after] = { description: descriptions?.after ?? '' };
	}
	return hooks;
}
