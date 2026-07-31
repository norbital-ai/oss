<!-- fallow-ignore-file complexity -- the scalar/multiple location editor intentionally composes search, selection, and map states -->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import * as Carousel from '#lib/carousel';
	import type { TComboboxProps, TOption } from '#lib/combobox';
	import { Combobox } from '#lib/combobox';
import { StaticMap } from '#lib/static-map';
import { Cluster, Inline, Stack } from '#lib/layout';
import { resource } from 'runed';
import type { TGeolocationPickerValue } from './geolocation.utils.js';

	type LocationOption = TOption<TGeolocationPickerValue, Record<string, never>>;

	type GeolocationPickerComboboxOmit =
		| 'display'
		| 'options'
		| 'value'
		| 'onValueChange'
		| 'readonly'
		| 'type'
		| 'serverConfig'
		| 'clientConfig';

	type GeolocationPickerShared = {
		class?: string;
		style?: string;
		readonly?: boolean;
		searchPlaceholder?: string;
		sameWidth?: boolean;
		autocomplete: (query: string) => Promise<TGeolocationPickerValue[]>;
	};

	type GeolocationPickerProps =
		| (GeolocationPickerShared & {
				multiple: true;
				value?: TGeolocationPickerValue[] | null;
				onValueChange?: (value: TGeolocationPickerValue[] | null) => void;
		  } & Omit<
					TComboboxProps<TGeolocationPickerValue, Record<string, never>, true>,
					GeolocationPickerComboboxOmit
				>)
		| (GeolocationPickerShared & {
				multiple: false;
				value?: TGeolocationPickerValue | null;
				onValueChange?: (value: TGeolocationPickerValue | null) => void;
		  } & Omit<
					TComboboxProps<TGeolocationPickerValue, Record<string, never>, false>,
					GeolocationPickerComboboxOmit
				>);

	let {
		value = $bindable(),
		class: className,
		style,
		multiple,
		readonly = false,
		searchPlaceholder = 'Search for a location...',
		onValueChange,
		sameWidth = true,
		autocomplete,
		...restProps
	}: GeolocationPickerProps = $props();

	let searchText = $state('');

	const searchResource = resource(
		() => searchText,
		(query) => autocomplete(query),
		{
			debounce: 300,
			initialValue: []
		}
	);

	const displayValue = $derived(value);

	const selectedLocations = $derived.by((): TGeolocationPickerValue[] => {
		if (!displayValue) return [];
		return Array.isArray(displayValue) ? displayValue : [displayValue];
	});

	const hasValidValues = $derived(selectedLocations.length > 0);

	const locationOptions = $derived.by((): LocationOption[] => {
		const uniqueByAddress: Record<string, TGeolocationPickerValue> = {};

		if (displayValue) {
			if (multiple && Array.isArray(displayValue)) {
				displayValue.forEach((selectedValue) => {
					if (selectedValue?.formatted_address) {
						uniqueByAddress[selectedValue.formatted_address] = selectedValue;
					}
				});
			} else if (!multiple && !Array.isArray(displayValue)) {
				if (displayValue.formatted_address) {
					uniqueByAddress[displayValue.formatted_address] = displayValue;
				}
			}
		}

		searchResource.current.forEach((geoValue) => {
			if (geoValue?.formatted_address) {
				uniqueByAddress[geoValue.formatted_address] = geoValue;
			}
		});

		return Object.entries(uniqueByAddress).map(([formattedAddress, geoValue]): LocationOption => ({
			label: formattedAddress,
			value: geoValue
		}));
	});

	function handleLocationSelection(
		selectedValue: TGeolocationPickerValue | TGeolocationPickerValue[] | null
	) {
		if (multiple) {
			const notify = onValueChange as ((v: TGeolocationPickerValue[] | null) => void) | undefined;
			if (!notify) return;
			if (Array.isArray(selectedValue)) {
				notify(selectedValue);
			} else if (selectedValue !== null) {
				notify([selectedValue]);
			} else {
				notify(null);
			}
		} else {
			const notify = onValueChange as ((v: TGeolocationPickerValue | null) => void) | undefined;
			if (!notify) return;
			if (Array.isArray(selectedValue)) {
				notify(selectedValue.length > 0 ? selectedValue[0] : null);
			} else {
				notify(selectedValue);
			}
		}
	}

	function handleSearch(query: string) {
		searchText = query;
	}

	function formatCoordinates(geometry: TGeolocationPickerValue['geometry']): string {
		if (!geometry) return 'No coordinates';
		return `${geometry.lat.toFixed(6)}, ${geometry.lon.toFixed(6)}`;
	}

	function getLocationTypeName(type: string): string {
		const typeMap: Record<string, string> = {
			geocode: 'Address',
			establishment: 'Business',
			point_of_interest: 'Point of Interest',
			political: 'Political Area',
			locality: 'City/Town',
			country: 'Country'
		};
		return typeMap[type] || type;
	}

	function handleLocationRemove(locationToRemove: TGeolocationPickerValue, event: Event) {
		if (readonly) return;
		event.stopPropagation();

		if (multiple && Array.isArray(value)) {
			const newValue = value.filter(
				(v) => v.formatted_address !== locationToRemove.formatted_address
			);
			const notify = onValueChange as ((v: TGeolocationPickerValue[] | null) => void) | undefined;
			notify?.(newValue);
		} else if (!multiple) {
			const notify = onValueChange as ((v: TGeolocationPickerValue | null) => void) | undefined;
			notify?.(null);
		}
	}
</script>

{#snippet locationOptionLabel(value: TGeolocationPickerValue)}
	<Inline gap="sm">
		<div class="shrink-0">
			{#if value.geometry}
				<Icon icon="lucide:map-pin" class="h-4 w-4 text-success" />
			{:else}
				<Icon icon="lucide:map-pin-off" class="h-4 w-4 text-orange-500" />
			{/if}
		</div>
		<Inline gap="sm" class="flex-1 text-start">
			<span class="truncate text-left text-xs font-normal transition-all">
				{value.formatted_address}
			</span>
			{#if !value.geometry}
				<span class="shrink-0 text-xs font-normal text-orange-600 transition-all"
					>No coordinates</span
				>
			{/if}
		</Inline>
	</Inline>
{/snippet}

{#snippet selectionDisplay(value: (TGeolocationPickerValue | TGeolocationPickerValue[]) | null)}
	{@const addresses: TGeolocationPickerValue[] = Array.isArray(value) ? value : value ? [value] : []}
	{#if addresses.length > 0}
		<Inline gap="xs" class="truncate">
			{#each addresses.slice(0, 2) as geoValue (geoValue.formatted_address)}
				<Badge variant="outline" class="flex max-w-[200px] items-center gap-1 px-2 py-0.5">
					<Icon
						icon={geoValue.geometry ? 'lucide:map-pin' : 'lucide:map-pin-off'}
						class={`h-3 w-3 shrink-0 ${geoValue.geometry ? 'text-success' : 'text-orange-500'}`}
					/>
					<span class="truncate text-xs">
						{geoValue?.formatted_address || 'Unknown location'}
					</span>
					{#if !readonly && multiple}
						<button
							type="button"
							class="ml-1 rounded-full hover:bg-secondary focus:ring-2 focus:ring-brand focus:outline-none"
							onclick={(e) => handleLocationRemove(geoValue, e)}
							aria-label="Remove {geoValue.formatted_address}"
						>
							<Icon icon="lucide:x" class="h-3 w-3" />
						</button>
					{/if}
				</Badge>
			{/each}

			{#if addresses.length > 2}
				<Badge variant="info" class="flex items-center gap-1 px-2 py-0.5">
					<Icon icon="lucide:more-horizontal" class="h-3 w-3" />
					<span class="text-xs">+{addresses.length - 2} more</span>
				</Badge>
			{/if}
		</Inline>
	{:else}
		<span class="text-xs font-normal text-muted-foreground transition-all">{searchPlaceholder}</span
		>
	{/if}
{/snippet}

{#snippet readonlySingleItem(location: TGeolocationPickerValue)}
	<Stack gap="md">
		<Inline gap="md" class="rounded-md bg-muted/40 p-3">
			<Icon
				icon={location.geometry ? 'lucide:map-pin' : 'lucide:map-pin-off'}
				class={location.geometry ? 'h-5 w-5 text-success' : 'h-5 w-5 text-orange-500'}
			/>
			<div class="min-w-0 flex-1">
				<p class="text-xs font-semibold text-foreground">{location.formatted_address}</p>
				<p class="truncate text-xs text-muted-foreground">
					{location.geometry ? formatCoordinates(location.geometry) : 'No coordinates available'}
				</p>
			</div>
		</Inline>

		{#if location.geometry}
			<Stack gap="sm" class="h-full p-2">
				<Inline gap="sm" class="text-sm font-medium text-secondary-foreground">
					<Icon icon="lucide:map" class="h-4 w-4" />
					Location map
				</Inline>
				<StaticMap
					markers={[
						{ latitude: location.geometry.lat, longitude: location.geometry.lon, label: 'A' }
					]}
					ariaLabel={`Map of ${location.formatted_address}`}
					class="h-[12.5rem]"
				/>
			</Stack>
		{/if}

		<Stack gap="sm" class="h-full p-2">
			<Inline gap="sm" class="text-sm font-medium text-secondary-foreground">
				<Icon icon="lucide:info" class="h-4 w-4" />
				Location Details
			</Inline>
			<Stack gap="xs" class="pl-6">
				<p class="font-mono text-xs text-muted-foreground">
					{#if location.geometry}
						Lat: {location.geometry.lat.toFixed(6)}°
						<br />
						Lon: {location.geometry.lon.toFixed(6)}°
						<br />
						SRID: {location.srid}
					{:else}
						No coordinates available for this location
					{/if}
				</p>

				<Cluster gap="sm" class="pt-2">
					{#if location.geometry}
						<Inline
							as="span"
							gap="xs"
							class="rounded-full bg-success/10 px-2 py-1 text-xs text-success-foreground"
						>
							<Icon icon="lucide:check" class="h-3 w-3" />
							Geocoded
						</Inline>
					{:else}
						<Inline
							as="span"
							gap="xs"
							class="rounded-full bg-orange-100 px-2 py-1 text-xs text-orange-800"
						>
							<Icon icon="lucide:alert-triangle" class="h-3 w-3" />
							No Coordinates
						</Inline>
					{/if}

					<Inline
						as="span"
						gap="xs"
						class="rounded-full bg-brand-100 px-2 py-1 text-xs text-brand-700"
					>
						<Icon icon="lucide:map" class="h-3 w-3" />
						{getLocationTypeName(location.type)}
					</Inline>

					{#if location.srid === 4326}
						<Inline
							as="span"
							gap="xs"
							class="rounded-full bg-purple-100 px-2 py-1 text-xs text-purple-800"
						>
							<Icon icon="lucide:satellite" class="h-3 w-3" />
							GPS Compatible
						</Inline>
					{/if}
				</Cluster>
			</Stack>
		</Stack>
	</Stack>
{/snippet}

{#snippet readonlyContent()}
	{#if hasValidValues}
		<Carousel.Root class="w-full">
			<Carousel.Content>
				{#each selectedLocations as location (location.formatted_address)}
					<Carousel.Item>
						{@render readonlySingleItem(location)}
					</Carousel.Item>
				{/each}
			</Carousel.Content>
			{#if selectedLocations.length > 1}
				<Carousel.Previous class="left-0!" />
				<Carousel.Next class="right-0!" />
			{/if}
		</Carousel.Root>
	{:else}
		<div class="py-8 text-center text-muted-foreground">
			<Icon icon="lucide:map-pin-off" class="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
			<p class="text-sm">No locations selected</p>
		</div>
	{/if}
{/snippet}

<Combobox
	type="server"
	class={className ? `${className} group` : 'group'}
	value={displayValue}
	align="start"
	minWidth={readonly ? 400 : undefined}
	{sameWidth}
	{style}
	{readonly}
	onValueChange={handleLocationSelection}
	options={locationOptions.map((option) => ({
		...option,
		label: locationOptionLabel
	}))}
	display={selectionDisplay}
	readonlyContent={readonly ? readonlyContent : undefined}
	serverConfig={{
		onSearch: handleSearch,
		isLoading: searchResource.loading
	}}
	searchPlaceholder="Type to search for locations..."
	{multiple}
	{emptyPlaceholder}
	{...restProps}
/>

{#snippet emptyPlaceholder()}
	<Inline gap="sm" class="text-xs text-muted-foreground">
		<Icon icon="lucide:map-pin-off" class="h-6 w-6" />
		<p>No locations selected</p>
	</Inline>
{/snippet}
