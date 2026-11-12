<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import Map, { type MapOverlay } from '../src/map/Map.svelte';
	import type { ViewBolt } from '../src/client/contract.ts';
	import { mount_edge } from '../src/effect/index.ts';
	let { bolt }: { bolt: ViewBolt } = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	const ctx: UiContext = { ui: { get bolt() { return bolt; }, kinds: { catalog: { places: {
		record_label: 'record.name', label: ['name'],
		fields: { name: { kind: 'text' }, position: { kind: 'point' } }
	} } } } };
	let overlays = $state<MapOverlay[]>([{ lat: 1, lng: 2, text: 'Initial destination', from: { lat: 0, lng: 0 } }]);
	let labels = $state<'hover' | 'always'>('hover');
	let interactive = $state(true);
	export function change_overlay(): void {
		const first = overlays[0];
		if (first === undefined || first.from === undefined) throw new Error('Missing fixture overlay.');
		first.lat = 3;
		first.lng = 4;
		first.text = 'Updated destination';
		first.from.lat = 5;
		first.from.lng = 6;
	}
	export function always_label(): void { labels = 'always'; }
	export function disable_clicks(): void { interactive = false; }
</script>

<Map {ctx} of="places" at="position" label="name" {overlays} {labels} {interactive} toolbar={false} />
