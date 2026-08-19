import { mount, unmount } from 'svelte';
import BoltWorkspace from './workspace.svelte';
import { setWorkspaceSession } from '../../session.js';
import type {
	MountWorkspaceOptions,
	WorkspaceHandle,
	WorkspaceView
} from './workspace-contract.js';

/**
 * Mounts a compiled workspace into a host-owned element and hands back a grip on it.
 *
 * This is the entire boundary. A host imports the artifact's entry module over HTTP, calls this, and
 * from then on says only three things: what changed (`update`), that it is done (`destroy`), and
 * what it will do when asked (the callbacks in `options.actions`). Nothing structural crosses —
 * the bundle carries its own Svelte and its own design system, which is why the host could not
 * render these surfaces as children and why it must not try to.
 *
 * The order inside is load-bearing. The session is declared *before* the workspace is loaded,
 * because loading it evaluates the generated client, which builds the browser runtime, whose query
 * cache is namespaced by tenant and environment. A cache namespaced from a value that arrives after
 * it is built is a cache shared between organizations.
 */
export const mountWorkspace = async (
	target: HTMLElement,
	options: MountWorkspaceOptions
): Promise<WorkspaceHandle> => {
	setWorkspaceSession(options.session);
	const workspace = await options.loadWorkspace();
	/**
	 * The view the mounted tree actually watches.
	 *
	 * Created here, by *this* bundle's Svelte, and mutated by `update`. A `$state` object handed in
	 * from the host would be a proxy over the host's reactive graph: reads from inside this bundle
	 * would register nowhere, and the shell would render the first view forever.
	 */
	const view = $state<WorkspaceView>({ ...options.view });
	const app = mount(BoltWorkspace, {
		target,
		props: { view, workspace, actions: options.actions }
	});
	return {
		update: (next) => {
			Object.assign(view, next);
		},
		destroy: () => {
			void unmount(app);
		}
	};
};
