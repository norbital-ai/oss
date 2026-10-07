<script lang="ts" module>
	import type { CollectionKey, FieldOf, RecordFieldOf, RowOf, WhereOf } from './bolt.js';
	import type { Toolbar } from './ViewToolbar.svelte';
	/** Extra marks drawn over the rows: a labelled point, and optionally a dashed line to it from `from`. */
	export type MapOverlay = { lat: number; lng: number; text?: string; from?: { lat: number; lng: number } };
	/** Rows of `of` with a `point` field `at`, on the host's keyless basemap; a click opens the record. */
	export type MapProps<C = CollectionKey> = { of: C; at: FieldOf<C>; where?: WhereOf<C>; label?: RecordFieldOf<C>; interactive?: boolean; limit?: number;
		/** `always`: each row's label sits beside its point instead of appearing on hover. */
		labels?: 'hover' | 'always';
		/** Marks the page computes (a destination, the route to it); they also widen the view to fit. */
		overlays?: readonly MapOverlay[];
		/** The chrome (`ViewToolbar`); search and filter narrow the places. */
		toolbar?: Toolbar<RowOf<C>>; key?: string };
</script>

<script lang="ts">
	// Needs no provider (P19): OpenStreetMap tiles unless the host overrides them; a tile failure still lists the rows.
	import type { Map as LeafletMap, LayerGroup } from 'leaflet';
	import { DEFAULT_BASEMAP, useKinds } from '../kinds/context.js';
	import { openRecord, useBolt } from './bolt.js';
	import { watch } from './live.svelte.js';
	import { and, compact, isRow, label as labelOf, listSelect, msg, nextOf, refOf, rowsOf, show, unref } from './model.js';
	import ReadGate from './ReadGate.svelte';
	import { viewState } from './view-state.svelte.js';
	import ViewToolbar from './ViewToolbar.svelte';

	let { of, at, where, label, interactive = true, limit = 500, toolbar = {}, key, labels = 'hover', overlays = [] }: MapProps = $props();
	const bolt = useBolt();
	const host = useKinds();
	const catalog = $derived(host.catalog ?? {});
	const view = viewState(bolt, { key: () => key ?? of, collection: () => of, catalog: () => catalog, initialFilter: () => undefined });
	let q = $state(''), search = $state('');
	$effect(() => { const t = q; const timer = setTimeout(() => (search = t.trim()), 300); return () => clearTimeout(timer); });
	const page = watch(() => bolt.live(bolt.read(of, compact({ where: and(where, view.where, { [at]: { isNull: false } }) ?? null, search: search || undefined,
		select: listSelect(host.catalog, of, label === undefined ? [] : [label]), limit }))));
	const points = $derived(page.state.kind === 'ready' ? unref(host.catalog, of, label === undefined ? [] : [label], rowsOf(page.state.value)).flatMap((r) => {
		const p = r[at];
		return isRow(p) && typeof p['lat'] === 'number' && typeof p['lng'] === 'number' ? [{ id: String(r['id']), lat: p['lat'], lng: p['lng'], text: label ? refOf(r, label)?.text ?? show(r[label] ?? null) : '' }] : [];
	}) : []);
	let failed = $state(false);
	let map: LeafletMap | undefined, layer: LayerGroup | undefined, L: typeof import('leaflet') | undefined;

	function draw() {
		if (map === undefined || layer === undefined || L === undefined) return;
		layer.clearLayers();
		for (const o of overlays) {
			if (o.from) L.polyline([[o.from.lat, o.from.lng], [o.lat, o.lng]], { weight: 2, dashArray: '6 6', opacity: 0.7 }).addTo(layer);
			const m = L.circleMarker([o.lat, o.lng], { radius: 5, fillOpacity: 0.15, dashArray: '2 3' }).addTo(layer);
			if (o.text) m.bindTooltip(o.text, { direction: 'bottom', opacity: 0.85 });
		}
		for (const p of points) {
			const m = L.circleMarker([p.lat, p.lng], { radius: 7, fillOpacity: 0.6 }).addTo(layer);
			if (p.text) m.bindTooltip(p.text, labels === 'always' ? { permanent: true, direction: 'right', offset: [8, 0] } : {});
			if (interactive) m.on('click', () => openRecord(of, p.id));
		}
		const all = [...points, ...overlays].map((p) => [p.lat, p.lng] as [number, number]);
		// unanimated: a zoom animation still running when the view unmounts writes to panes Leaflet has already removed
		if (all.length > 0) map.fitBounds(L.latLngBounds(all), { maxZoom: 15, padding: [24, 24], animate: false });
	}
	$effect(() => { void points; void overlays; draw(); });
	function mount(node: HTMLElement) {
		let cancelled = false, own: LeafletMap | undefined;
		const basemap = host.basemap ?? DEFAULT_BASEMAP;
		import('leaflet').then((module) => {
			if (cancelled) return;
			L = module;
			map = own = module.map(node, { worldCopyJump: true, dragging: interactive, scrollWheelZoom: interactive, zoomControl: interactive }).setView([0, 0], 2);
			module.tileLayer(basemap.url, { attribution: basemap.attribution, maxZoom: 19 }).on('tileerror', () => (failed = true)).addTo(map);
			layer = module.layerGroup().addTo(map);
			draw();
		}, () => (failed = true));
		const resize = new ResizeObserver(() => own?.invalidateSize({ animate: false }));
		resize.observe(node);
		// a removed map is forgotten, so a data change before the next mount draws nothing instead of into a dead map
		return { destroy() { cancelled = true; resize.disconnect(); own?.remove(); if (map === own) map = layer = undefined; } };
	}
</script>

<ViewToolbar config={toolbar} collection={of} {view} {catalog} author={where} bind:q searchable={(catalog[of]?.search?.length ?? 0) > 0} />
<ReadGate state={page.state} what={labelOf(bolt, of)}>
	{#snippet children(value)}
		<div class="flex flex-col gap-1" data-view="map">
			<div class="h-80 w-full rounded-md border" use:mount></div>
			{#if failed}<p class="text-muted-foreground text-xs">{msg(bolt, 'map.tiles', 'The map could not load; the places are listed below.')}</p>{/if}
			{#if points.length === 0}<p class="text-muted-foreground text-sm" data-read="empty">{msg(bolt, 'map.empty', 'No places to show')}</p>{/if}
			{#if failed}<ul class="text-sm">{#each points as p (p.id)}<li>{p.text || p.id}: {p.lat}, {p.lng}</li>{/each}</ul>{/if}
			{#if nextOf(value) !== null}<p class="text-muted-foreground text-xs">{msg(bolt, 'map.limit', 'Showing the first {n}', { n: limit })}</p>{/if}
		</div>
	{/snippet}
</ReadGate>
