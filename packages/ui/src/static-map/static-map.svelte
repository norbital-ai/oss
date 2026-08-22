<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Effect } from 'effect';
	import type { Map as LeafletMap } from 'leaflet';
	import type { Snippet } from 'svelte';
	import type { Action } from 'svelte/action';
	import { fromAction } from 'svelte/attachments';
	import { cn } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import type { StaticMapMarker } from '#lib/static-map/static-map.types';

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

	let ready = $state(false);
	let errorMessage = $state<string>();
	let markerPositions = $state<
		readonly { readonly left: number; readonly top: number; readonly visible: boolean }[]
	>([]);

	const mountMap: Action<HTMLElement, readonly StaticMapMarker[]> = (container, initialMarkers) => {
		let cancelled = false;
		let resizeObserver: ResizeObserver | undefined;
		let map: LeafletMap | undefined;
		let leaflet: typeof import('leaflet') | undefined;
		let currentMarkers = initialMarkers;

		function updateMarkerPositions(): void {
			if (!map) return;
			const visibleBounds = map.getBounds().pad(0.1);
			markerPositions = currentMarkers.map((marker) => {
				const point = map?.latLngToContainerPoint([marker.latitude, marker.longitude]);
				return {
					left: point?.x ?? 0,
					top: point?.y ?? 0,
					visible: visibleBounds.contains([marker.latitude, marker.longitude])
				};
			});
		}

		function fitMarkers(): void {
			if (!map || !leaflet || currentMarkers.length === 0) {
				markerPositions = [];
				return;
			}
			const bounds = leaflet.latLngBounds(
				currentMarkers.map((marker) => [marker.latitude, marker.longitude])
			);
			map.fitBounds(bounds, { animate: false, padding: [56, 56], maxZoom: 12 });
			map.setZoom(Math.max(map.getMinZoom(), map.getZoom() - 1), { animate: false });
			updateMarkerPositions();
		}

		void Effect.runPromise(
			Effect.gen(function* () {
				const module = yield* Effect.tryPromise(() => import('leaflet'));
				if (cancelled) return;
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
				fitMarkers();
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						errorMessage = error.message;
					})
				)
			)
		);

		return {
			update(nextMarkers) {
				currentMarkers = nextMarkers;
				if (ready) fitMarkers();
			},
			destroy() {
				cancelled = true;
				resizeObserver?.disconnect();
				map?.remove();
				map = undefined;
			}
		};
	};
</script>

<section
	class={cn(
		'relative isolate z-0 h-[20rem] overflow-hidden rounded-lg border border-border bg-muted/30',
		className
	)}
	aria-label={ariaLabel}
>
	<div
		class="absolute inset-0 z-0"
		aria-label={`${ariaLabel}. Drag to pan; use the zoom controls or mouse wheel to zoom.`}
		{@attach fromAction(mountMap, () => markers)}
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
		<Inline
			align="start"
			gap="md"
			class="absolute inset-x-4 top-4 z-20 rounded-md border border-border bg-background/95 p-3 shadow-sm backdrop-blur"
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
				<p class="text-meta">
					{errorMessage ?? emptyDescription}
				</p>
			</div>
		</Inline>
	{/if}
</section>
