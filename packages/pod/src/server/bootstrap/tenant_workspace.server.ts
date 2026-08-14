import type { RuntimeWorkspace } from '$lib/authoring/workspace/workspace-runtime.js';
import type {
	AnyCollectionBehavior,
	AnyHookBundle
} from '$lib/authoring/schema/collection-behavior.js';
import { buildNorbitalManifest, type NorbitalManifest } from '$lib/manifest/index.js';

let tenantWorkspace: RuntimeWorkspace | undefined;

export function registerTenantWorkspace(workspace: RuntimeWorkspace): void {
	tenantWorkspace = workspace;
}

export function getTenantWorkspace(): RuntimeWorkspace {
	if (!tenantWorkspace) throw new Error('Tenant workspace has not been registered');
	return tenantWorkspace;
}

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

/**
 * The NorbitalManifest for the registered tenant workspace. Single source of
 * truth for both the runtime `getManifest` request and the `manifest.json`
 * build artifact, so the file the host reads is byte-for-byte the projection the
 * isolate would have returned.
 */
export function getTenantManifest(): NorbitalManifest {
	const workspace = getTenantWorkspace();
	return buildNorbitalManifest({ ...workspace, registered: workspace.registered });
}
