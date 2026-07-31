import { mount, type Component } from 'svelte';
import type { CollectionSurfaceRegistry } from '@norbital-ai/ui/collection-table';
import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';
import PodApp from './pod-app.svelte';
import { initializeWorkspaceClient } from './client.js';
import { bootstrapClientSync } from '../client/sync/browser-bootstrap.js';
import { setStorageScope } from '@norbital-ai/ui/storage-scope';
import { warmAllCollections } from '../client/sync/client-sync.js';
import type { TenantWorkspaceShellData } from '../client/workspace_shell_types.js';

/**
 * How long the background warm pass waits before starting.
 *
 * Long enough for the page's own reads to be issued and answered, short enough that a user
 * navigating a few seconds later already finds the next collection local.
 */
const WARM_START_DELAY_MS = 1_500;

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
			const replica = bootstrapClientSync(data.sync);
			const workspaceApi = initializeWorkspaceClient(
				data.initialWorkspaceLatest.columns,
				data.initialWorkspaceLatest.manifest
			);

			// Warm the rest of the workspace once this page has what it needs. Without it the replica
			// only ever holds what has been looked at, so "slow the first time" repeats on every page
			// a user opens rather than once per device. The delay keeps it strictly behind first
			// paint — the collections this page is waiting on must not queue behind forty others.
			void replica.then((sync) => {
				if (!sync) return;
				setTimeout(() => void warmAllCollections(sync), WARM_START_DELAY_MS);
			});

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
