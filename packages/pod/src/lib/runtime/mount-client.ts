import { mount, type Component } from 'svelte';
import type { CollectionSurfaceRegistry } from '@norbital-ai/ui/collection-table';
import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';
import PodApp from './pod-app.svelte';
import { initializeWorkspaceClient } from './client.js';
import { bootstrapClientSync } from '../client/sync/browser-bootstrap.js';
import type { TenantWorkspaceShellData } from '../client/workspace_shell_types.js';

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
			return {
				data,
				workspaceApi: initializeWorkspaceClient(
					data.initialWorkspaceLatest.columns,
					data.initialWorkspaceLatest.manifest
				)
			};
		}
	);
	void bootstrapClientSync();
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
