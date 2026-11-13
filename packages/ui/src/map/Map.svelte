<!--
@component
A model's records placed by a `point` field on the host's keyless basemap, with its toolbar; a click opens the record.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { ModelKey, FieldOf, RecordFieldOf, RowOf, WhereOf } from '../model/types.js';
	import type { Toolbar } from '../model/ViewToolbar.svelte';
	/** Extra marks drawn over the rows: a labelled point, and optionally a dashed line to it from `from`. */
	export type MapOverlay = {
		lat: number;
		lng: number;
		/** The mark's label. */
		text?: string;
		/** Draws a dashed line from here to the mark. */
		from?: { lat: number; lng: number };
	};
	/** Rows of `of` with a `point` field `at`, on the host's keyless basemap; a click opens the record. */
	type MapProps<C = ModelKey> = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The model whose records are placed. */
		of: C;
		/** The `point` field that places each record; rows without one are left out. */
		at: FieldOf<C>;
		/** The author's fixed scope; the viewer's filter is ANDed under it. */
		where?: WhereOf<C>;
		/** The field (or relation, by its target's label) that names each point. */
		label?: RecordFieldOf<C>;
		/** Pan, zoom and click-to-open. Default true; false is a static picture. */
		interactive?: boolean;
		/** The most rows read. Default 500. */
		limit?: number;
		/** `always`: each row's label sits beside its point instead of appearing on hover. */
		labels?: 'hover' | 'always';
		/** Marks the page computes (a destination, the route to it); they also widen the view to fit. */
		overlays?: readonly MapOverlay[];
		/** The chrome (`ViewToolbar`); search and filter narrow the places. */
		toolbar?: Toolbar<RowOf<C>>;
		/** The URL parameter prefix; defaults to `of`. */
		key?: string;
	};
</script>

<script lang="ts" generics="C extends ModelKey">
	import { Effect } from 'effect';
	import { Debounced, watch } from 'runed';
	import { onDestroy } from 'svelte';
	import { attach } from '../effect/index.js';
	import { format_value as show, isPoint } from '../kinds/kind.js';
	// Needs no provider (P19): OpenStreetMap tiles unless the host overrides them; a tile failure still lists the rows.
	import type { Map as LeafletMap, LayerGroup } from 'leaflet';
	import { DEFAULT_BASEMAP } from '../kinds/context.js';
	import { open_record } from '../record/navigation.js';
	import { bolt_of } from '../client/context.js';
	import { and } from '../filter/scope.js';
	import { label as labelOf, msg } from '../text/messages.js';
	import { listRequest, refOf, unref } from '../relations/select.js';
	import { page_of, request_json } from '../read/request.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { mapped, queryState } from '../read/state.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar from '../model/ViewToolbar.svelte';

	let {
		ctx,
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
	const bolt = $derived(bolt_of(ctx));
	const host = $derived(ctx.ui.kinds);
	const catalog = $derived(host.catalog ?? {});
	const view = viewState(() => ctx, {
		key: () => key ?? of,
		model: () => of,
		catalog: () => catalog,
		initial_filter: () => undefined
	});
	let q = $state('');
	const debouncedSearch = new Debounced(() => q, 300);
	onDestroy(debouncedSearch.cancel);
	const search = $derived(debouncedSearch.current.trim());
	const page = $derived(
		queryState(
			mapped(
				bolt.query(
					request_json(
						listRequest(
							host.catalog,
							of,
							{
								where: and(where, view.where, { [at]: { is_null: false } }),
								search: search || undefined,
								limit
							},
							label === undefined ? [] : [label]
						)
					)
				),
				(answer) => page_of(answer, of)
			)
		)
	);
	const points = $derived(
		page.kind === 'ready'
			? unref(host.catalog, of, label === undefined ? [] : [label], page.value.rows).flatMap(
					(r) => {
						const p = r[at];
						return isPoint(p)
							? [
									{
										id: r.id,
										lat: p.lat,
										lng: p.lng,
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

	/** A point's mark: its initial in an accent ring, and under it its label as a pill when labels are `always`. */
	function point_mark(text: string, shown: 'hover' | 'always'): HTMLElement {
		const root = document.createElement('span');
		root.className = 'map-point';
		const mark = root.appendChild(document.createElement('span'));
		mark.className = 'map-point-mark';
		mark.textContent = text.trim().charAt(0).toUpperCase() || '•';
		if (shown === 'always' && text) {
			const pill = root.appendChild(document.createElement('span'));
			pill.className = 'map-point-pill';
			pill.textContent = text;
		}
		return root;
	}
	function draw() {
		if (map === undefined || layer === undefined || L === undefined) return;
		layer.clearLayers();
		for (const o of overlays) {
			if (o.from) {
				const route: [number, number][] = [
					[o.from.lat, o.from.lng],
					[o.lat, o.lng]
				];
				L.polyline(route, { weight: 10, className: 'map-route-glow', interactive: false }).addTo(layer);
				L.polyline(route, { weight: 2, className: 'map-route', interactive: false }).addTo(layer);
			}
			const m = L.circleMarker([o.lat, o.lng], {
				radius: 6,
				dashArray: '2 3',
				className: 'map-mark'
			}).addTo(layer);
			if (o.text) m.bindTooltip(o.text, { direction: 'bottom' });
		}
		for (const p of points) {
			const m = L.marker([p.lat, p.lng], {
				icon: L.divIcon({ className: '', iconSize: [0, 0], html: point_mark(p.text, labels) }),
				keyboard: interactive
			}).addTo(layer);
			if (p.text && labels === 'hover') m.bindTooltip(p.text, { direction: 'top', offset: [0, -18] });
			if (interactive) m.on('click', () => open_record(of, p.id));
		}
		const all = [...points, ...overlays].map((p): [number, number] => [p.lat, p.lng]);
		// unanimated: a zoom animation still running when the view unmounts writes to panes Leaflet has already removed
		if (all.length > 0)
			map.fitBounds(L.latLngBounds(all), { maxZoom: 15, padding: [24, 24], animate: false });
	}
	watch(
		[
			() => points,
			() => overlays.map((overlay) => [overlay.lat, overlay.lng, overlay.text, overlay.from?.lat, overlay.from?.lng]),
			() => labels,
			() => interactive,
			() => of
		],
		() => draw()
	);
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
							// no one-finger pan on touch, so the page still scrolls past the map
							dragging: interactive && !module.Browser.mobile,
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

<ViewToolbar {ctx}
	config={toolbar}
	model={of}
	{view}
	{catalog}
	author={where}
	bind:q
	searchable={(catalog[of]?.search?.length ?? 0) > 0}
/>
<ReadGate {ctx} state={page} what={labelOf(bolt, of)}>
	{#snippet children(value)}
		<div class="flex flex-col gap-1" data-view="map">
			<div class="isolate z-0 h-80 w-full overflow-clip rounded-lg border" {@attach mount}></div>
			{#if failed}<p class="text-muted-foreground text-xs">
					{msg(bolt, 'map.tiles')}
				</p>{/if}
			{#if points.length === 0}<p class="text-muted-foreground text-sm" data-read="empty">
					{msg(bolt, 'map.empty')}
				</p>{/if}
			{#if failed}<ul class="text-sm">
					{#each points as p (p.id)}<li>{p.text || p.id}: {p.lat}, {p.lng}</li>{/each}
				</ul>{/if}
			{#if value.next !== null}<p class="text-muted-foreground text-xs">
					{msg(bolt, 'map.limit', { n: limit })}
				</p>{/if}
		</div>
	{/snippet}
</ReadGate>
