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

export function hooksDeclaredFromBehavior(
	behavior: AnyCollectionBehavior | undefined
): Record<string, true> {
	const hooks: Record<string, true> = {};
	if (!behavior) return hooks;
	if (collectionHooks(behavior, 'create')?.before) hooks.beforeCreate = true;
	if (collectionHooks(behavior, 'create')?.after) hooks.afterCreate = true;
	if (collectionHooks(behavior, 'update')?.before) hooks.beforeUpdate = true;
	if (collectionHooks(behavior, 'update')?.after) hooks.afterUpdate = true;
	if (collectionHooks(behavior, 'delete')?.before) hooks.beforeDelete = true;
	if (collectionHooks(behavior, 'delete')?.after) hooks.afterDelete = true;
	return hooks;
}
