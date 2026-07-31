import { mount, unmount, type Component } from 'svelte';
import type { CollectionSurfaceRegistry } from '@norbital-ai/ui/collection-table';
import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';
import PodApp from './pod-app.svelte';
import { initializeWorkspaceClient, resetWorkspaceRuntime } from './client.js';
import { bootstrapClientSync, teardownClientSync } from '../client/sync/replica.js';
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

/** The live tree and what it was built from, so an organization switch can rebuild it. */
let mounted: ReturnType<typeof mount> | null = null;
let mountedModules: PodWorkspaceClientModules | null = null;

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
	mounted = mount(PodApp, {
		target: document.body,
		props: {
			apps: modules.apps,
			collectionSurfaces: modules.collectionSurfaces,
			customTypeRenderers: modules.customTypeRenderers,
			shellData
		}
	});
	mountedModules = modules;
}

/**
 * Move this tab to another organization without reloading the document.
 *
 * The switch used to be `window.location.assign('/')`, which is correct by construction and slow
 * for it: the bundle is parsed and executed again to reach a screen the browser was already
 * showing. What made the reload necessary was module state — six query caches, the collection
 * client, the published schema, the replica handle and its warm bit all outlive a component tree,
 * and all of them belong to one tenant. Any of them carried across would show the previous
 * organization's records to the next.
 *
 * So the teardown is explicit and total rather than avoided: close the replica, clear the caches,
 * drop the schema, unmount the tree. Then mount again exactly as a cold load would, which is why
 * this reuses `mountPodWorkspace` instead of reproducing it — there is one description of how a
 * workspace starts, and a switch is just another start.
 *
 * Note the ORDER. Teardown happens before the new shell is fetched, so there is no window in which
 * the new organization's identity is active while the old one's rows are still cached.
 */
export async function switchOrganization(organizationId: string): Promise<void> {
	const response = await fetch('/api/auth/organization/set-active', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId })
	});
	if (!response.ok) throw new Error('Unable to switch workspace');

	const modules = mountedModules;
	const tree = mounted;
	if (!modules || !tree) {
		// Nothing was mounted through this module, so there is no state here to trust. Fall back to
		// the reload, which is always correct.
		window.location.assign('/');
		return;
	}

	await unmount(tree);
	mounted = null;
	resetWorkspaceRuntime();
	setStorageScope(null);
	await teardownClientSync();

	mountPodWorkspace(modules);
}
