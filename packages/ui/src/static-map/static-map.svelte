<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Map as LeafletMap } from 'leaflet';
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils';
	import * as Popover from '../popover';
	import type { StaticMapMarker } from './static-map.types.js';

	let {
		markers,
		ariaLabel,
		emptyDescription = 'No mapped locations are available.',
		markerContent,
		class: className
	}: {
		markers: readonly StaticMapMarker[];
		ariaLabel: string;
		emptyDescription?: string;
		markerContent?: Snippet<[StaticMapMarker, number]>;
		class?: string;
	} = $props();

	let container = $state<HTMLElement>();
	let map: LeafletMap | undefined;
	let leaflet: typeof import('leaflet') | undefined;
	let ready = $state(false);
	let errorMessage = $state<string>();
	let markerPositions = $state<
		readonly { readonly left: number; readonly top: number; readonly visible: boolean }[]
	>([]);
	const markerSignature = $derived(
		markers.map(({ latitude, longitude }) => `${latitude}:${longitude}`).join('|')
	);

	function updateMarkerPositions(): void {
		if (!map) return;
		const visibleBounds = map.getBounds().pad(0.1);
		markerPositions = markers.map((marker) => {
			const point = map?.latLngToContainerPoint([marker.latitude, marker.longitude]);
			return {
				left: point?.x ?? 0,
				top: point?.y ?? 0,
				visible: visibleBounds.contains([marker.latitude, marker.longitude])
			};
		});
	}

	function fitMarkers(): void {
		if (!map || !leaflet || markers.length === 0) return;
		const bounds = leaflet.latLngBounds(
			markers.map((marker) => [marker.latitude, marker.longitude])
		);
		map.fitBounds(bounds, { animate: false, padding: [56, 56], maxZoom: 12 });
		map.setZoom(Math.max(map.getMinZoom(), map.getZoom() - 1), { animate: false });
		updateMarkerPositions();
	}

	onMount(() => {
		let cancelled = false;
		let resizeObserver: ResizeObserver | undefined;

		void import('leaflet')
			.then((module) => {
				if (cancelled || !container) return;
				leaflet = module;
				map = module.map(container, {
					attributionControl: true,
					keyboard: true,
					minZoom: 3,
					maxZoom: 18,
					scrollWheelZoom: true,
					worldCopyJump: true,
					zoomControl: true
				});
				map.setView([1.3521, 103.8198], 9, { animate: false });

				const tiles = module.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
					attribution: '&copy; OpenStreetMap contributors',
					crossOrigin: true,
					maxZoom: 18
				});
				tiles.on('tileerror', () => {
					errorMessage = 'The interactive basemap could not be loaded.';
				});
				tiles.addTo(map);
				map.on('move zoom resize', updateMarkerPositions);

				resizeObserver = new ResizeObserver(() => {
					map?.invalidateSize({ animate: false, pan: false });
					updateMarkerPositions();
				});
				resizeObserver.observe(container);
				ready = true;
			})
			.catch((cause: unknown) => {
				errorMessage = cause instanceof Error ? cause.message : String(cause);
			});

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
			map?.remove();
			map = undefined;
		};
	});

	$effect(() => {
		markerSignature;
		if (!ready) return;
		fitMarkers();
	});
</script>

<section
	class={cn(
		'relative isolate z-0 h-[20rem] overflow-hidden rounded-lg border border-border bg-muted/30',
		className
	)}
	aria-label={ariaLabel}
>
	<div
		bind:this={container}
		class="absolute inset-0 z-0"
		aria-label={`${ariaLabel}. Drag to pan; use the zoom controls or mouse wheel to zoom.`}
	></div>

	{#if ready && markers.length > 0}
		<div class="pointer-events-none absolute inset-0 z-10">
			{#each markerPositions as position, index (index)}
				{@const marker = markers[index]}
				{#if marker && position.visible}
					<Popover.Root>
						<Popover.Trigger
							class={cn(
								'pointer-events-auto absolute flex size-8 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full border-2 border-background text-xs font-semibold text-white shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
								marker.tone === 'alert' ? 'bg-destructive' : 'bg-amber-700'
							)}
							style={`left: ${position.left}px; top: ${position.top}px;`}
							aria-label={marker.ariaLabel ?? `Map marker ${marker.label ?? index + 1}`}
						>
							{marker.label ?? index + 1}
						</Popover.Trigger>
						{#if markerContent}
							<Popover.Content class="w-auto p-3">
								{@render markerContent(marker, index)}
							</Popover.Content>
						{/if}
					</Popover.Root>
				{/if}
			{/each}
		</div>
	{/if}

	{#if !ready || errorMessage || markers.length === 0}
		<div
			class="absolute inset-x-4 top-4 z-20 flex items-start gap-3 rounded-md border border-border bg-background/95 p-3 shadow-sm backdrop-blur"
			role={errorMessage ? 'alert' : undefined}
		>
			<Icon
				icon={errorMessage
					? 'lucide:map-pinned'
					: !ready
						? 'lucide:loader-circle'
						: 'lucide:route-off'}
				class={cn('mt-0.5 size-4 shrink-0', !ready && 'animate-spin')}
			/>
			<div>
				<p class="text-sm font-medium">
					{errorMessage ? 'Map unavailable' : !ready ? 'Loading map' : 'No mapped locations'}
				</p>
				<p class="text-xs text-muted-foreground">
					{errorMessage ?? emptyDescription}
				</p>
			</div>
		</div>
	{/if}
</section>
