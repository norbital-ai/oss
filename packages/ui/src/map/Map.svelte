<!--
@component
A model's records placed by a `point` field on our own vector basemap (MapLibre over keyless OpenFreeMap tiles, styled
from the design tokens and following the theme), with its toolbar.

Each record is a round mark with its initial; `badge` (or the label, with `labels="always"`) hangs a pill under it.
Marks that crowd one spot draw as one accent-ringed count that splits as the map zooms in (a click zooms to it).
Hovering or focusing a mark, or a row of the optional side `list`, selects it: a floating card shows its title,
`status`, `fields` as chips and `description`; the selected row is outlined in the accent. A click on a mark, a row
or the card's button opens the record. `overlays` add computed marks and glowing accent routes.
@example
```svelte
<Map {ctx} of="sites" at="location" label="name" status="state" fields={['crew', 'due']} badge="open_jobs" list />
```
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { ModelKey, FieldOf, RecordFieldOf, RowOf, WhereOf } from '../model/types.js';
	import type { Toolbar } from '../model/ViewToolbar.svelte';
	/** Extra marks drawn over the rows: a labelled point, and optionally a glowing route to it from `from`. */
	export type MapOverlay = {
		lat: number;
		lng: number;
		/** The mark's label. */
		text?: string;
		/** Draws a route from here to the mark. */
		from?: { lat: number; lng: number };
	};
	/** Rows of `of` with a `point` field `at`, on our basemap; a click opens the record. */
	type MapProps<C = ModelKey> = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The model whose records are placed. */
		of: C;
		/** The `point` field that places each record; rows without one are left out. */
		at: FieldOf<C>;
		/** The author's fixed scope; the viewer's filter is ANDed under it. */
		where?: WhereOf<C>;
		/** The field (or relation, by its target's label) that names each point; default the record label. */
		label?: RecordFieldOf<C>;
		/** A field shown beside the title in the card and the list (a `state` shows as its badge). */
		status?: RecordFieldOf<C>;
		/** A count or metric hung as a pill under each mark. */
		badge?: RecordFieldOf<C>;
		/** Fields shown as small chips in the selected record's card. */
		fields?: readonly RecordFieldOf<C>[];
		/** A short text shown in the card under the chips. */
		description?: RecordFieldOf<C>;
		/** A list of the places beside the map, synced with its selection. */
		list?: boolean;
		/** Pan, zoom, selection and click-to-open. Default true; false is a static picture. */
		interactive?: boolean;
		/** The most rows read. Default 500. */
		limit?: number;
		/** `always`: without a `badge`, each row's label hangs as the pill under its mark. */
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
	import type { Map as MapLibre } from 'maplibre-gl';
	import { attach } from '../effect/index.js';
	import { format_value as show, isPoint, recordText } from '../kinds/kind.js';
	import { basemap } from './basemap.js';
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
	import Value from '../cell/Value.svelte';
	import { Button } from '../primitives/button/index.js';
	import Split from '../layout/split.svelte';
	import type { Values } from '../model/types.js';

	let {
		ctx,
		of,
		at,
		where,
		label,
		status,
		badge,
		fields = [],
		description,
		list = false,
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
	const shown = $derived(
		[...new Set([label, status, badge, description, ...fields])].filter((f) => f !== undefined)
	);
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
							shown
						)
					)
				),
				(answer) => page_of(answer, of)
			)
		)
	);
	type Place = { id: string; lat: number; lng: number; text: string; row: Values };
	const points: Place[] = $derived(
		page.kind === 'ready'
			? unref(host.catalog, of, shown, page.value.rows).flatMap((row) => {
					const p = row[at];
					const text = label ? (refOf(row, label)?.text ?? show(row[label] ?? null)) : '';
					return isPoint(p)
						? [{ id: row.id, lat: p.lat, lng: p.lng, row, text: text || recordText(catalog[of], row) }]
						: [];
				})
			: []
	);
	const initial = (text: string) => text.trim().charAt(0).toUpperCase() || '•';

	let failed = $state(false),
		ready = $state(false);
	let map: MapLibre | undefined;
	/** Bumped on every camera move: what reads it re-projects. */
	let frame = $state(0);
	/** The whole zoom the clusters are cut at: they change only when it does. */
	let zoom = $state(0);
	let selected = $state<string | null>(null);
	const card = $derived(selected === null ? undefined : points.find((p) => p.id === selected));
	let rows: HTMLElement | undefined = $state();

	/** A point on screen, from the world copy nearest the view's centre. */
	function xy(lat: number, lng: number): { x: number; y: number } {
		void frame;
		if (map === undefined) return { x: 0, y: 0 };
		const centre = map.getCenter().lng;
		return map.project([lng + 360 * Math.round((centre - lng) / 360), lat]);
	}
	/** Clusters: points in one 48px cell of the world at this whole zoom draw as one; from street level none. */
	const CELL = 48;
	const groups = $derived.by(() => {
		if (zoom >= 16) return points.map((p) => [p]);
		const scale = (512 * 2 ** zoom) / CELL;
		const cells = new Map<string, Place[]>();
		for (const p of points) {
			const s = Math.sin((p.lat * Math.PI) / 180);
			const key = `${Math.floor(((p.lng + 180) / 360) * scale)}:${Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale)}`;
			const cell = cells.get(key);
			if (cell === undefined) cells.set(key, [p]);
			else cell.push(p);
		}
		return [...cells.values()];
	});
	const centre = (group: readonly Place[]) => ({
		lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
		lng: group.reduce((s, p) => s + p.lng, 0) / group.length
	});
	const bounds = (all: readonly { lat: number; lng: number }[]): [[number, number], [number, number]] => [
		[Math.min(...all.map((p) => p.lng)), Math.min(...all.map((p) => p.lat))],
		[Math.max(...all.map((p) => p.lng)), Math.max(...all.map((p) => p.lat))]
	];

	function fit() {
		const all = [...points, ...overlays];
		// unanimated: an animation still running when the view unmounts writes to a removed map
		if (map !== undefined && all.length > 0)
			map.fitBounds(bounds(all), { maxZoom: 15, padding: 48, animate: false });
	}
	watch(
		() => [...points, ...overlays].map((p) => [p.lat, p.lng]).join(),
		() => fit()
	);
	/** Selects a place; from the map its row scrolls into view, from the list the map pans to it when it is out of view. */
	function select(id: string, from: 'map' | 'list') {
		selected = id;
		if (from === 'map')
			rows?.querySelector(`[data-map-row=${JSON.stringify(id)}]`)?.scrollIntoView?.({ block: 'nearest' });
		const p = points.find((p) => p.id === id);
		if (from === 'list' && map !== undefined && p !== undefined && !map.getBounds().contains([p.lng, p.lat]))
			map.easeTo({ center: [p.lng, p.lat] });
	}
	const mount = attach((node: HTMLElement) =>
		Effect.gen(function* () {
			const { map: own } = yield* basemap(node, { interactive });
			let loaded = false;
			own.once('load', () => (loaded = true));
			own.on('error', () => {
				if (!loaded) failed = true;
			});
			own.on('move', () => frame++);
			own.on('zoom', () => {
				const z = Math.floor(own.getZoom());
				if (z !== zoom) zoom = z;
			});
			own.on('click', () => (selected = null));
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					map = own;
					ready = true;
					zoom = Math.floor(own.getZoom());
					fit();
				}),
				() =>
					Effect.sync(() => {
						if (map !== own) return;
						map = undefined;
						ready = false;
					})
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
{#snippet value(row: Values, f: string)}
	<Value {ctx} value={row[f]} kind={catalog[of]?.fields[f]} {row} ref={refOf(row, f)} name={f} dense link={false} />
{/snippet}
{#snippet pill(p: Place)}
	{#if badge !== undefined && p.row[badge] !== null && p.row[badge] !== undefined}
		<span class="map-pill">{@render value(p.row, badge)}</span>
	{:else if badge === undefined && labels === 'always' && p.text}
		<span class="map-pill">{p.text}</span>
	{/if}
{/snippet}
{#snippet canvas()}
	<div class="relative isolate z-0 h-80 w-full overflow-clip rounded-lg border bg-background">
		<div class="size-full" {@attach mount}></div>
		<!-- marks, routes and the card over the canvas: only they take the pointer; the rest pans the map -->
		<div
			class="pointer-events-none absolute inset-0 overflow-hidden"
			data-map-overlay
			role="presentation"
			onkeydown={(e) => {
				if (e.key === 'Escape') selected = null;
			}}
		>
			{#if ready}
				<svg class="absolute inset-0 size-full" aria-hidden="true">
					{#each overlays as o, i (i)}
						{#if o.from}
							{@const a = xy(o.from.lat, o.from.lng)}
							{@const b = xy(o.lat, o.lng)}
							<line class="map-route-glow" x1={a.x} y1={a.y} x2={b.x} y2={b.y} data-map-route />
							<line class="map-route" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
						{/if}
					{/each}
				</svg>
				{#each overlays as o, i (i)}
					{@const at = xy(o.lat, o.lng)}
					<span class="map-at" style:left="{at.x}px" style:top="{at.y}px" data-map-mark>
						<span class="map-ring"></span>
						{#if o.text}<span class="map-pill">{o.text}</span>{/if}
					</span>
				{/each}
				{#each groups as group (group.map((p) => p.id).join())}
					{@const c = centre(group)}
					{@const at = xy(c.lat, c.lng)}
					{#if group.length > 1}
						<button
							type="button"
							disabled={!interactive}
							class="map-at map-cluster"
							style:left="{at.x}px"
							style:top="{at.y}px"
							data-map-cluster={group.length}
							aria-label={group.map((p) => p.text).join(', ')}
							onclick={() =>
								map?.fitBounds(bounds(group), { padding: 64, maxZoom: 17, duration: 300 })}
						>
							{group.length}
						</button>
					{:else}
						{@const p = group[0]!}
						<button
							type="button"
							disabled={!interactive}
							class="map-at map-point"
							style:left="{at.x}px"
							style:top="{at.y}px"
							data-map-point={p.id}
							data-selected={selected === p.id || undefined}
							aria-label={p.text}
							onpointerenter={() => select(p.id, 'map')}
							onfocus={() => select(p.id, 'map')}
							onclick={() => open_record(of, p.id)}
						>
							<span class="map-mark">{initial(p.text)}</span>
							{@render pill(p)}
						</button>
					{/if}
				{/each}
				{#if interactive && card !== undefined}
					{@const at = xy(card.lat, card.lng)}
					<div
						class="bg-popover text-popover-foreground pointer-events-auto absolute flex w-64 flex-col gap-2 rounded-lg border p-3 shadow-deep"
						class:map-card-below={at.y < 200}
						class:map-card-above={at.y >= 200}
						style:left="clamp(8.5rem, {at.x}px, calc(100% - 8.5rem))"
						style:top="{at.y}px"
						data-map-card={card.id}
					>
						<div class="flex min-w-0 items-center gap-2">
							<span class="map-mark shrink-0">{initial(card.text)}</span>
							<span class="min-w-0 flex-1 truncate font-medium" data-map-title>{card.text}</span>
							{#if status !== undefined}{@render value(card.row, status)}{/if}
						</div>
						{#if fields.length > 0}
							<div class="flex flex-wrap gap-1">
								{#each fields as f (f)}
									<span class="rounded-badge inline-flex border items-center gap-1 px-1.5 py-0.5 text-xs" data-map-chip={f}
										><span class="text-muted-foreground">{labelOf(bolt, of, f)}</span>{@render value(card.row, f)}</span
									>
								{/each}
							</div>
						{/if}
						{#if description !== undefined && card.row[description]}
							<p class="text-muted-foreground line-clamp-2 text-xs">{@render value(card.row, description)}</p>
						{/if}
						<Button variant="outline" class="w-full" onclick={() => open_record(of, card.id)}
							>{msg(bolt, 'map.open')}</Button
						>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/snippet}
<ReadGate {ctx} state={page} what={labelOf(bolt, of)}>
	{#snippet children(result)}
		<div class="flex flex-col gap-1" data-view="map">
			{#if list}
				<Split ratio="wide" gap="sm">
					{#snippet start()}{@render canvas()}{/snippet}
					{#snippet end()}
						<ul class="flex h-80 flex-col gap-1 overflow-y-auto" bind:this={rows} data-map-list>
							{#each points as p (p.id)}
								<li>
									<button
										type="button"
										class="hover:bg-accent flex w-full min-w-0 items-center gap-2 rounded-md border border-transparent p-2 text-left text-sm data-[selected]:border-brand data-[selected]:ring-1 data-[selected]:ring-brand"
										data-map-row={p.id}
										data-selected={selected === p.id || undefined}
										onpointerenter={() => select(p.id, 'list')}
										onfocus={() => select(p.id, 'list')}
										onclick={() => open_record(of, p.id)}
									>
										<span class="map-mark shrink-0">{initial(p.text)}</span>
										<span class="min-w-0 flex-1 truncate">{p.text}</span>
										{#if status !== undefined}{@render value(p.row, status)}{/if}
										{#if badge !== undefined && p.row[badge] !== null && p.row[badge] !== undefined}
											<span class="map-pill">{@render value(p.row, badge)}</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/snippet}
				</Split>
			{:else}
				{@render canvas()}
			{/if}
			{#if failed}<p class="text-muted-foreground text-xs">
					{msg(bolt, 'map.tiles')}
				</p>{/if}
			{#if points.length === 0}<p class="text-muted-foreground text-sm" data-read="empty">
					{msg(bolt, 'map.empty')}
				</p>{/if}
			{#if failed && !list}<ul class="text-sm">
					{#each points as p (p.id)}<li>{p.text || p.id}: {p.lat}, {p.lng}</li>{/each}
				</ul>{/if}
			{#if result.next !== null}<p class="text-muted-foreground text-xs">
					{msg(bolt, 'map.limit', { n: limit })}
				</p>{/if}
		</div>
	{/snippet}
</ReadGate>

<style>
	/* Everything over the canvas sits at its point; the centre of a mark is the point. */
	.map-at {
		position: absolute;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		width: max-content;
		transform: translate(-50%, -0.875rem);
		pointer-events: auto;
		font: inherit;
	}
	span.map-at,
	.map-at:disabled {
		pointer-events: none;
	}
	/* A record: its initial on the accent tint, ringed in the accent. */
	.map-mark {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 9999px;
		background: var(--brand-muted);
		color: var(--brand-text);
		border: 2px solid var(--brand);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 18%, transparent);
		font-size: 11px;
		font-weight: 590;
		transition:
			transform var(--motion-fast) var(--ease-out),
			box-shadow var(--motion-fast) var(--ease-out);
	}
	.map-point:hover .map-mark,
	.map-point:focus-visible .map-mark,
	.map-point[data-selected] .map-mark {
		transform: scale(1.12);
		background: var(--brand);
		color: var(--brand-foreground);
		box-shadow:
			0 0 0 5px color-mix(in oklab, var(--brand) 28%, transparent),
			var(--shadow-deep);
	}
	.map-point:focus-visible {
		outline: none;
	}
	/* A count or label under a mark. */
	.map-pill {
		display: inline-flex;
		align-items: center;
		max-width: 10rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid color-mix(in oklab, var(--foreground) 14%, transparent);
		box-shadow: var(--shadow-deep);
		font-size: 11px;
		font-weight: 510;
	}
	/* Crowded marks: their count in an accent ring on the popover surface. */
	.map-cluster {
		display: grid;
		place-items: center;
		min-width: 2.25rem;
		height: 2.25rem;
		padding: 0 0.5rem;
		transform: translate(-50%, -50%);
		border-radius: 9999px;
		background: var(--popover);
		color: var(--brand-text);
		border: 2px solid var(--brand);
		box-shadow:
			0 0 0 6px color-mix(in oklab, var(--brand) 14%, transparent),
			var(--shadow-deep);
		font-size: 12px;
		font-weight: 590;
		cursor: pointer;
	}
	/* A computed mark: a dashed accent ring. */
	.map-ring {
		width: 0.75rem;
		height: 0.75rem;
		margin-top: 0.5rem;
		border-radius: 9999px;
		border: 1.5px dashed var(--brand);
		background: color-mix(in oklab, var(--brand) 12%, transparent);
	}
	/* A route: a soft accent glow under a fine accent line. */
	.map-route-glow {
		stroke: var(--brand);
		stroke-width: 10;
		stroke-opacity: 0.22;
		stroke-linecap: round;
		filter: blur(2px);
	}
	.map-route {
		stroke: var(--brand);
		stroke-width: 2;
		stroke-linecap: round;
	}
	/* The card floats over its point, flipped below near the top edge. */
	.map-card-above {
		transform: translate(-50%, calc(-100% - 1.5rem));
	}
	.map-card-below {
		transform: translate(-50%, 1.5rem);
	}
</style>
