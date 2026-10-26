<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	// Mounts a Sheet with a page input outside it, a Drawer and a LogView.
	import { Tabs } from '../src/primitives/tabs/index.js';
	import Drawer from '../src/primitives/sheet/drawer.svelte';
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	import LogView from '../src/logs/LogView.svelte';
	import GuardProbe from './guard-probe.svelte';
	import type { LogLine } from '../src/logs/logs.js';
	import type { LogViewProps } from '../src/logs/LogView.svelte';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));

	let {
		part,
		sheetOpen = $bindable(false),
		drawerOpen = $bindable(false),
		path = '/a',
		rows = [],
		loadOlder,
		hasOlder = false,
		dirty = () => false
	}: {
		part: 'sheet' | 'drawer' | 'logs' | 'guarded';
		dirty?: () => boolean;
		sheetOpen?: boolean;
		drawerOpen?: boolean;
		path?: string;
		rows?: readonly LogLine[];
		loadOlder?: LogViewProps['loadOlder'];
		hasOlder?: boolean;
	} = $props();
</script>

{#snippet leaf()}<p>leaf</p>{/snippet}
{#snippet inSheet()}<Tabs tabs={[{ name: 's', title: 'S', body: leaf }]} /><input
		data-inside
	/>{/snippet}

{#snippet page()}
	<input data-outside />
	<Sheet bind:open={sheetOpen} title="Record">{@render inSheet()}</Sheet>
{/snippet}

{#if part === 'guarded'}
	<Sheet bind:open={sheetOpen} title="Draft"><GuardProbe {dirty} /></Sheet>
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
