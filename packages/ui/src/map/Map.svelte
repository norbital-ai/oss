<script lang="ts" module>
	import type {
		ModelKey,
		FieldOf,
		RecordFieldOf,
		RowOf,
		WhereOf
	} from '../model/types.js';
	import type { Toolbar } from '../model/ViewToolbar.svelte';
	/** Extra marks drawn over the rows: a labelled point, and optionally a dashed line to it from `from`. */
	export type MapOverlay = {
		lat: number;
		lng: number;
		text?: string;
		from?: { lat: number; lng: number };
	};
	/** Rows of `of` with a `point` field `at`, on the host's keyless basemap; a click opens the record. */
	export type MapProps<C = ModelKey> = {
		of: C;
		at: FieldOf<C>;
		where?: WhereOf<C>;
		label?: RecordFieldOf<C>;
		interactive?: boolean;
		limit?: number;
		/** `always`: each row's label sits beside its point instead of appearing on hover. */
		labels?: 'hover' | 'always';
		/** Marks the page computes (a destination, the route to it); they also widen the view to fit. */
		overlays?: readonly MapOverlay[];
		/** The chrome (`ViewToolbar`); search and filter narrow the places. */
		toolbar?: Toolbar<RowOf<C>>;
		key?: string;
	};
</script>

<script lang="ts" generics="C extends ModelKey">
	import { Effect } from 'effect';
	import { attach } from '../effect/index.js';
	import { formatValue as show } from '../kinds/kind.js';
	// Needs no provider (P19): OpenStreetMap tiles unless the host overrides them; a tile failure still lists the rows.
	import type { Map as LeafletMap, LayerGroup } from 'leaflet';
	import { DEFAULT_BASEMAP, useKinds } from '../kinds/context.js';
	import { openRecord } from '../record/navigation.js';
	import { useBolt } from '../client/context.js';
	import { and } from '../filter/scope.js';
	import { isRow, nextOf, rowsOf } from '../read/results.js';
	import { label as labelOf, msg } from '../text/messages.js';
	import { listRequest, refOf, unref } from '../relations/select.js';
	import { pageOf, requestJson } from '../read/request.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { mapped, queryState } from '../read/state.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar from '../model/ViewToolbar.svelte';

	let {
		of,
		at,
		where,
		label,
		interactive = true,
		limit = 500,
		toolbar = {},
		key,
		labels = 'hover',
		overlays = []
	}: MapProps<C> = $props();
	const bolt = useBolt();
	const host = useKinds();
	const catalog = $derived(host.catalog ?? {});
	const view = viewState(bolt, {
		key: () => key ?? of,
		model: () => of,
		catalog: () => catalog,
		initialFilter: () => undefined
	});
	let q = $state(''),
		search = $state('');
	$effect(() => {
		const t = q;
		const timer = setTimeout(() => (search = t.trim()), 300);
		return () => clearTimeout(timer);
	});
	const page = $derived(
		queryState(
			mapped(
				bolt.query(
					requestJson(
						listRequest(
							host.catalog,
							of,
							{
								where: and(where, view.where, { [at]: { isNull: false } }),
								search: search || undefined,
								limit
							},
							label === undefined ? [] : [label]
						)
					)
				),
				(answer) => pageOf(answer, of)
			)
		)
	);
	const points = $derived(
		page.kind === 'ready'
			? unref(host.catalog, of, label === undefined ? [] : [label], rowsOf(page.value)).flatMap(
					(r) => {
						const p = r[at];
						return isRow(p) && typeof p['lat'] === 'number' && typeof p['lng'] === 'number'
							? [
									{
										id: r.id,
										lat: p['lat'],
										lng: p['lng'],
										text: label ? (refOf(r, label)?.text ?? show(r[label] ?? null)) : ''
									}
								]
							: [];
					}
				)
			: []
	);
	let failed = $state(false);
	let map: LeafletMap | undefined,
		layer: LayerGroup | undefined,
		L: typeof import('leaflet') | undefined;

	function draw() {
		if (map === undefined || layer === undefined || L === undefined) return;
		layer.clearLayers();
		for (const o of overlays) {
			if (o.from)
				L.polyline(
					[
						[o.from.lat, o.from.lng],
						[o.lat, o.lng]
					],
					{ weight: 2, dashArray: '6 6', opacity: 0.7 }
				).addTo(layer);
			const m = L.circleMarker([o.lat, o.lng], {
				radius: 5,
				fillOpacity: 0.15,
				dashArray: '2 3'
			}).addTo(layer);
			if (o.text) m.bindTooltip(o.text, { direction: 'bottom', opacity: 0.85 });
		}
		for (const p of points) {
			const m = L.circleMarker([p.lat, p.lng], { radius: 7, fillOpacity: 0.6 }).addTo(layer);
			if (p.text)
				m.bindTooltip(
					p.text,
					labels === 'always' ? { permanent: true, direction: 'right', offset: [8, 0] } : {}
				);
			if (interactive) m.on('click', () => openRecord(of, p.id));
		}
		const all = [...points, ...overlays].map((p) => [p.lat, p.lng] as [number, number]);
		// unanimated: a zoom animation still running when the view unmounts writes to panes Leaflet has already removed
		if (all.length > 0)
			map.fitBounds(L.latLngBounds(all), { maxZoom: 15, padding: [24, 24], animate: false });
	}
	$effect(() => {
		void points;
		void overlays;
		draw();
	});
	const mount = attach((node: HTMLElement) =>
		Effect.gen(function* () {
			const module = yield* Effect.tryPromise({
				try: () => import('leaflet'),
				catch: (cause) => ({ _tag: 'MapFailed' as const, cause })
			});
			const basemap = host.basemap ?? DEFAULT_BASEMAP;
			const own = yield* Effect.acquireRelease(
				Effect.sync(() =>
					module
						.map(node, {
							worldCopyJump: true,
							dragging: interactive,
							scrollWheelZoom: interactive,
							zoomControl: interactive
						})
						.setView([0, 0], 2)
				),
				(own) =>
					Effect.sync(() => {
						own.remove();
						if (map === own) {
							map = undefined;
							layer = undefined;
						}
					})
			);
			L = module;
			map = own;
			module
				.tileLayer(basemap.url, { attribution: basemap.attribution, maxZoom: 19 })
				.on('tileerror', () => {
					failed = true;
				})
				.addTo(own);
			layer = module.layerGroup().addTo(own);
			draw();
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const resize = new ResizeObserver(() => own.invalidateSize({ animate: false }));
					resize.observe(node);
					return resize;
				}),
				(resize) => Effect.sync(() => resize.disconnect())
			);
			yield* Effect.never;
		}).pipe(
			Effect.catch(() =>
				Effect.sync(() => {
					failed = true;
				})
			)
		)
	);
</script>

<ViewToolbar
	config={toolbar}
	model={of}
	{view}
	{catalog}
	author={where}
	bind:q
	searchable={(catalog[of]?.search?.length ?? 0) > 0}
/>
<ReadGate state={page} what={labelOf(bolt, of)}>
	{#snippet children(value)}
		<div class="flex flex-col gap-1" data-view="map">
			<div class="h-80 w-full rounded-md border" {@attach mount}></div>
			{#if failed}<p class="text-muted-foreground text-xs">
					{msg(bolt, 'map.tiles', 'The map could not load; the places are listed below.')}
				</p>{/if}
			{#if points.length === 0}<p class="text-muted-foreground text-sm" data-read="empty">
					{msg(bolt, 'map.empty', 'No places to show')}
				</p>{/if}
			{#if failed}<ul class="text-sm">
					{#each points as p (p.id)}<li>{p.text || p.id}: {p.lat}, {p.lng}</li>{/each}
				</ul>{/if}
			{#if nextOf(value) !== null}<p class="text-muted-foreground text-xs">
					{msg(bolt, 'map.limit', 'Showing the first {n}', { n: limit })}
				</p>{/if}
		</div>
	{/snippet}
</ReadGate>
