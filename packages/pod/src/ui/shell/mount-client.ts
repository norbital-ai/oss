import { mount, type Component } from 'svelte';
import type { CollectionSurfaceRegistry } from '@norbital-ai/ui/collection-table';
import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';
import PodApp from './pod-app.svelte';
import { initializeWorkspaceClient } from '../state/client.js';
import { bootstrapClientSync } from '../sync/replica.js';
import { setStorageScope } from '@norbital-ai/ui/storage-scope';
import type { TenantWorkspaceShellData } from '../state/workspace_shell_types.js';

export interface PodWorkspaceClientModules {
	readonly apps: Readonly<Record<string, () => Promise<Component>>>;
	readonly collectionSurfaces: CollectionSurfaceRegistry;
	readonly customTypeRenderers: CustomTypeRendererMap;
}

/** Mount a compiled tenant module set into the host-neutral Pod browser runtime. */
export function mountPodWorkspace(modules: PodWorkspaceClientModules): void {
	const shellData = fetch('/_pod/bootstrap', { credentials: 'include' }).then(
		async (
			response
		): Promise<{
			data: TenantWorkspaceShellData;
			workspaceApi: ReturnType<typeof initializeWorkspaceClient>;
		}> => {
			if (!response.ok) throw new Error(`Workspace bootstrap failed (${response.status})`);
			const data: TenantWorkspaceShellData = await response.json();
			// Namespace browser storage before anything can write to it. Every tenant is served from
			// this same origin, so an unscoped key is shared between them.
			setStorageScope(data.organization.id);
			// Start opening the replica the moment its identity is known. Reads await the promise
			// this registers, so a device that already holds the rows answers from disk instead of
			// asking the server for them again.
			void bootstrapClientSync(data.sync);
			const workspaceApi = initializeWorkspaceClient(
				data.initialWorkspaceLatest.columns,
				data.initialWorkspaceLatest.manifest
			);

			return { data, workspaceApi };
		}
	);
	mount(PodApp, {
		target: document.body,
		props: {
			apps: modules.apps,
			collectionSurfaces: modules.collectionSurfaces,
			customTypeRenderers: modules.customTypeRenderers,
			shellData
		}
	});
}
