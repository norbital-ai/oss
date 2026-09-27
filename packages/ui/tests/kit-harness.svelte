<script lang="ts">
	// Mounts the kit pieces under test: nested Tabs, a Sheet with a page input outside it, a Drawer, a LogView.
	import { Tabs } from '../src/primitives/tabs/index.js';
	import { Drawer, Sheet } from '../src/primitives/sheet/index.js';
	import LogView from '../src/views/LogView.svelte';
	import type { LogLine } from '../src/views/logs.js';
	import type { TabLevel } from '../src/primitives/tabs/level.js';

	let {
		part,
		innerLevel,
		sheetOpen = $bindable(false),
		drawerOpen = $bindable(false),
		path = '/a',
		rows = [],
		loadOlder,
		hasOlder = false
	}: {
		part: 'tabs' | 'sheet' | 'drawer' | 'logs';
		innerLevel?: TabLevel;
		sheetOpen?: boolean;
		drawerOpen?: boolean;
		path?: string;
		rows?: readonly LogLine[];
		loadOlder?: () => Promise<unknown>;
		hasOlder?: boolean;
	} = $props();
</script>

{#snippet leaf()}<p>leaf</p>{/snippet}
{#snippet third()}<Tabs tabs={[{ name: 'x', title: 'X', body: leaf }]} />{/snippet}
{#snippet second()}<Tabs level={innerLevel} tabs={[{ name: 'b', title: 'B', body: third }]} />{/snippet}
{#snippet inSheet()}<Tabs tabs={[{ name: 's', title: 'S', body: leaf }]} /><input data-inside />{/snippet}

{#snippet page()}
	<input data-outside />
	<Sheet bind:open={sheetOpen} title="Record">{@render inSheet()}</Sheet>
{/snippet}

{#if part === 'tabs'}
	<Tabs tabs={[{ name: 'a', title: 'A', body: second }]} />
{:else if part === 'sheet'}
	<Tabs tabs={[{ name: 'p', title: 'P', body: page }]} />
{:else if part === 'drawer'}
	<Drawer bind:open={drawerOpen} {path} title="Nav">
		<a href="/b" data-link>B</a>
		<a href="/c" target="_blank" data-blank>C</a>
		<span data-text>text</span>
	</Drawer>
{:else}
	<div style="height: 200px"><LogView {rows} {loadOlder} {hasOlder} class="h-full" /></div>
{/if}
