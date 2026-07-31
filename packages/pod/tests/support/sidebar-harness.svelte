<script lang="ts">
	import * as Sidebar from '@norbital-ai/ui/sidebar';
	import type { Component } from 'svelte';

	/**
	 * The sidebar context, and nothing else.
	 *
	 * `Sidebar.MenuButton` reads `useSidebar()`, so anything that lives in the sidebar cannot be
	 * mounted bare. Standing up the whole `WorkspaceShell` to obtain that context would drag the
	 * router, the manifest and the platform state into tests about a bell and a list of links.
	 */
	let {
		component: Subject,
		props
	}: {
		component: Component<Record<string, unknown>, Record<string, unknown>, string>;
		props: Record<string, unknown>;
	} = $props();
</script>

<Sidebar.Provider>
	<Subject {...props} />
</Sidebar.Provider>
