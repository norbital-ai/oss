import type {
	AnyCollectionBehavior,
	AnyHookBundle
} from '$lib/authoring/schema/collection-behavior.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';

export function getWorkspaceCollection(name: string): AnyCollectionBehavior | undefined {
	return getTenantWorkspace().collections[name];
}

export function collectionHooks(
	behavior: AnyCollectionBehavior | undefined,
	action: 'create' | 'update' | 'delete'
): AnyHookBundle | undefined {
	return behavior?.[action]?.hooks;
}

export function allowsMutation(
	behavior: AnyCollectionBehavior | undefined,
	action: 'create' | 'update' | 'delete'
): boolean {
	return behavior?.[action] !== undefined;
}
