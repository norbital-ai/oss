<!--
@component
A `point` on a keyless basemap (P19): OpenStreetMap tiles unless the host overrides them. With `onPick` a click or a marker
drag sets the point; without it the map is a static view. Leaflet loads only when a map mounts; a failed load or tile
error leaves the rest of the field working.
-->
<script lang="ts">
	import type { Map as LeafletMap, Marker } from 'leaflet';
	import { cn, uiText } from '../primitives/utils.js';
	import { DEFAULT_BASEMAP, useKinds } from './context.js';
	import type { Point } from './kind.js';

	let { value, onPick, disabled = false, class: className }: { value: Point | null; onPick?(p: Point): void; disabled?: boolean; class?: string } = $props();
	const host = useKinds();
	const t = uiText();
	/** Street level: where a known point is shown, and the least a value is zoomed to. */
	const STREET = 16;
	let failed = $state(false), ready = $state(false);
	let map: LeafletMap | undefined, marker: Marker | undefined, L: typeof import('leaflet') | undefined;
	const interactive = $derived(onPick !== undefined && !disabled);
	const round = (lat: number, lng: number): Point => ({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) });

	function place(p: Point | null) {
		if (map === undefined || L === undefined) return;
		if (p === null) { marker?.remove(); marker = undefined; return; }
		if (marker === undefined) {
			marker = L.marker([p.lat, p.lng], {
				keyboard: false, draggable: interactive,
				icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: '<span class="block size-5 rounded-full border-2 border-background bg-primary shadow-md"></span>' })
			}).addTo(map);
			marker.on('dragend', () => { const at = marker!.getLatLng().wrap(); onPick?.(round(at.lat, at.lng)); });
		} else marker.setLatLng([p.lat, p.lng]);
		// a typed or located point is always brought into view at street level; a drag within view leaves the map still
		if (map.getZoom() < STREET - 3) map.setView([p.lat, p.lng], STREET, { animate: false });
		else if (!map.getBounds().pad(-0.1).contains([p.lat, p.lng])) map.panTo([p.lat, p.lng], { animate: false });
	}

	function mount(node: HTMLElement) {
		let cancelled = false;
		const basemap = host.basemap ?? DEFAULT_BASEMAP;
		import('leaflet').then((module) => {
			if (cancelled) return;
			L = module;
			// ponytail: no one-finger pan on touch, so a form still scrolls past the map; tap, drag the marker or search instead
			map = module.map(node, { attributionControl: true, worldCopyJump: true, scrollWheelZoom: false, dragging: !module.Browser.mobile });
			map.setView(value === null ? [20, 0] : [value.lat, value.lng], value === null ? 2 : STREET);
			module.tileLayer(basemap.url, { attribution: basemap.attribution, maxZoom: 19 }).on('tileerror', () => (failed = true)).addTo(map);
			map.on('click', (e) => { if (interactive) onPick?.(round(e.latlng.lat, e.latlng.wrap().lng)); });
			ready = true;
		}, () => (failed = true));
		const resize = new ResizeObserver(() => map?.invalidateSize({ animate: false }));
		resize.observe(node);
		return () => {
			cancelled = true;
			resize.disconnect();
			map?.remove();
			map = marker = undefined;
			ready = false;
		};
	}
	$effect(() => { if (ready) place(value); });
	$effect(() => {
		const on = interactive;
		if (!ready || map === undefined) return;
		for (const h of [map.doubleClickZoom, map.touchZoom, map.boxZoom, map.keyboard]) if (on) h.enable(); else h.disable();
		if (on && !L!.Browser.mobile) map.dragging.enable(); else map.dragging.disable();
		if (on) marker?.dragging?.enable(); else marker?.dragging?.disable();
	});
</script>

<div
	class={cn(
		'relative isolate z-0 h-56 overflow-clip rounded-md border border-input bg-muted/30 sm:h-64',
		// dark mode: the light OpenStreetMap tiles inverted into a dim map, markers and controls untouched
		'dark:[&_.leaflet-tile-pane]:[filter:invert(1)_hue-rotate(180deg)_brightness(0.9)_contrast(0.9)]',
		disabled && 'pointer-events-none opacity-60 saturate-50',
		className
	)}
	aria-disabled={disabled || undefined}
>
	<div class="absolute inset-0" {@attach mount} aria-label={onPick ? t('pickOnMap') : undefined}></div>
	{#if failed}
		<p class="absolute inset-x-2 top-2 z-[500] rounded-sm bg-background/95 p-2 text-xs text-muted-foreground shadow-sm">{t('mapUnavailable')}</p>
	{/if}
</div>
