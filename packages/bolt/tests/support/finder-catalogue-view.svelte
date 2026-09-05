<script lang="ts">
	import OmniFinder from '../../src/client/ui/shell/omni-finder.svelte';
	import type { WorkspaceClient } from '../../src/client/ui/studio/workspace-client.js';
	let { findRecords }: { findRecords: WorkspaceClient['records']['findMany'] } = $props();
	let collections = $state<string[]>([]);
	export function loadCollections(names: string[]) {
		collections = names;
	}
</script>

<OmniFinder
	open={true}
	{collections}
	{findRecords}
	getRecordLabel={() => 'name'}
	navigationModel={{
		activeOrganization: { id: 'test', name: 'Test' },
		organizations: [],
		user: { name: 'Test', email: 'test@example.test', role: 'Admin', teamLabels: [] },
		sections: [],
		system: [],
		applications: []
	}}
	onAskAgent={() => undefined}
/>
