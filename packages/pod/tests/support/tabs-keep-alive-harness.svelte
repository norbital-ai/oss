<script lang="ts">
	import Tabs from '../../../ui/src/tabs/tabs.svelte';
	import type { TabConfig } from '../../../ui/src/tabs/tabs.types.js';
	import Child from './tabs-keep-alive-child.svelte';

	let value = $state('board');
	let boardMounts = $state(0);
	let shiftsMounts = $state(0);

	function mounted(name: string): void {
		if (name === 'Board') boardMounts += 1;
		else shiftsMounts += 1;
	}
</script>

{#snippet board()}
	<Child name="Board" onMounted={mounted} />
{/snippet}
{#snippet shifts()}
	<Child name="Shifts" onMounted={mounted} />
{/snippet}

<p data-mounts>{boardMounts}:{shiftsMounts}</p>
<Tabs
	bind:value
	animate={false}
	config={[
		{ name: 'board', label: 'Board', content: board, keepAlive: true },
		{ name: 'shifts', label: 'Shifts', content: shifts, keepAlive: true }
	] satisfies TabConfig[]}
/>
