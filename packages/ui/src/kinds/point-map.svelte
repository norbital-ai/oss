<!--
@component
A `point` on our basemap (MapLibre over keyless vector tiles, following the theme). With `on_pick` a click or a marker
drag sets the point; without it the map is a static view. MapLibre loads only when a map mounts; a failed load or
style error leaves the rest of the field working.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import type { Map as MapLibre, Marker } from 'maplibre-gl';
	import { attach } from '../effect/index.js';
	import { basemap } from '../map/basemap.js';
	import { cn, ui_text } from '../primitives/utils.js';
	import type { Point } from './kind.js';

	let {
		value,
		on_pick,
		disabled = false,
		class: className
	}: {
		value: Point | null;
		on_pick?(p: Point): void;
		disabled?: boolean;
		class?: string;
	} = $props();
	const t = ui_text();
	/** Street level: where a known point is shown, and the least a value is zoomed to. */
	const STREET = 16;
	let failed = $state(false),
		ready = $state(false);
	let map: MapLibre | undefined, marker: Marker | undefined, maplibre: typeof import('maplibre-gl') | undefined;
	const interactive = $derived(on_pick !== undefined && !disabled);
	const round = (lat: number, lng: number): Point => ({
		lat: Number(lat.toFixed(6)),
		lng: Number(lng.toFixed(6))
	});

	function place(p: Point | null) {
		if (map === undefined || maplibre === undefined) return;
		if (p === null) {
			marker?.remove();
			marker = undefined;
			return;
		}
		if (marker === undefined) {
			const dot = document.createElement('span');
			dot.className =
				'block size-5 rounded-full border-2 border-background bg-brand shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-brand)_25%,transparent)]';
			const placed = new maplibre.Marker({ element: dot, draggable: interactive })
				.setLngLat([p.lng, p.lat])
				.addTo(map);
			marker = placed;
			placed.on('dragend', () => {
				if (marker !== placed) return;
				const at = placed.getLngLat().wrap();
				on_pick?.(round(at.lat, at.lng));
			});
		} else marker.setLngLat([p.lng, p.lat]);
		// a typed or located point is always brought into view at street level; a drag within view leaves the map still
		if (map.getZoom() < STREET - 3) map.jumpTo({ center: [p.lng, p.lat], zoom: STREET });
		else if (!map.getBounds().contains([p.lng, p.lat])) map.jumpTo({ center: [p.lng, p.lat] });
	}

	const mount = attach((node: HTMLElement) =>
		Effect.gen(function* () {
			// interactive: the handlers below follow `interactive` after mount; a static map still pans its own view
			const opened = yield* basemap(node, {
				interactive: true,
				center: value === null ? [0, 20] : [value.lng, value.lat],
				zoom: value === null ? 1 : STREET
			});
			const own = opened.map;
			// ponytail: scroll zoom off, so a form still scrolls past the map; the zoom buttons and a pinch zoom it
			own.scrollZoom.disable();
			let loaded = false;
			own.once('load', () => (loaded = true));
			own.on('error', () => {
				if (!loaded) failed = true;
			});
			own.on('click', (e) => {
				if (interactive) {
					const at = e.lngLat.wrap();
					on_pick?.(round(at.lat, at.lng));
				}
			});
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					map = own;
					maplibre = opened.maplibre;
					ready = true;
				}),
				() =>
					Effect.sync(() => {
						map = marker = undefined;
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
	$effect(() => {
		if (ready) place(value);
	});
	$effect(() => {
		const on = interactive;
		if (!ready || map === undefined) return;
		for (const h of [map.doubleClickZoom, map.touchZoomRotate, map.boxZoom, map.keyboard])
			if (on) h.enable();
			else h.disable();
		if (on && !matchMedia('(pointer: coarse)').matches) map.dragPan.enable();
		else map.dragPan.disable();
		map.touchZoomRotate.disableRotation();
		marker?.setDraggable(on);
	});
</script>

<div
	class={cn(
		'relative isolate z-0 h-56 overflow-clip rounded-md border border-input bg-background sm:h-64',
		disabled && 'pointer-events-none opacity-60 saturate-50',
		className
	)}
	aria-disabled={disabled || undefined}
>
	<div class="size-full" {@attach mount} aria-label={on_pick ? t('pickOnMap') : undefined}></div>
	{#if failed}
		<p
			class="absolute inset-x-2 top-2 z-10 rounded-sm bg-background/95 p-2 text-xs text-muted-foreground shadow-sm"
		>
			{t('mapUnavailable')}
		</p>
	{/if}
</div>
