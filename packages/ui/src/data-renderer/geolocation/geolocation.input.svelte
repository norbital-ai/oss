<!-- the scalar/multiple location editor intentionally composes search, selection, and map states -->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import * as Carousel from '#lib/carousel';
	import type { TComboboxProps, TOption } from '#lib/combobox';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { StaticMap } from '#lib/static-map';
	import { Cluster, Inline, Stack } from '#lib/layout';
	import { resource } from 'runed';
	import { Effect } from 'effect';
	import type { TGeolocationPickerValue } from '#lib/data-renderer/geolocation/geolocation.utils';

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
		autocomplete: (query: string) => Effect.Effect<TGeolocationPickerValue[], Error>;
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

	const { t } = useI18n<UiKeys>();

	let {
		value = $bindable(),
		class: className,
		style,
		multiple,
		readonly = false,
		searchPlaceholder = t('dataRenderer.searchLocation'),
		onValueChange,
		sameWidth = true,
		autocomplete,
		...restProps
	}: GeolocationPickerProps = $props();

	let searchText = $state('');

	const searchResource = resource(
		() => searchText,
		(query) => Effect.runPromise(autocomplete(query)),
		{
			debounce: 300,
			initialValue: []
		}
	);

	const selectedLocations = $derived.by((): TGeolocationPickerValue[] => {
		if (!value) return [];
		return Array.isArray(value) ? value : [value];
	});

	const hasValidValues = $derived(selectedLocations.length > 0);

	const locationOptions = $derived.by((): LocationOption[] => {
		// One entry per formatted address, whichever source it arrived from.
		const uniqueByAddress: Record<string, TGeolocationPickerValue> = {};
		const remember = (geoValue: TGeolocationPickerValue | null | undefined): void => {
			if (geoValue?.formatted_address) uniqueByAddress[geoValue.formatted_address] = geoValue;
		};

		if (multiple && Array.isArray(value)) value.forEach(remember);
		else if (!multiple && value && !Array.isArray(value)) remember(value);

		searchResource.current.forEach(remember);

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
		if (!geometry) return t('dataRenderer.noCoordinates');
		return `${geometry.lat.toFixed(6)}, ${geometry.lon.toFixed(6)}`;
	}

	function getLocationTypeName(type: string): string {
		const typeMap: Record<string, string> = {
			geocode: t('dataRenderer.locationTypeAddress'),
			establishment: t('dataRenderer.locationTypeBusiness'),
			point_of_interest: t('dataRenderer.locationTypePointOfInterest'),
			political: t('dataRenderer.locationTypePolitical'),
			locality: t('dataRenderer.locationTypeLocality'),
			country: t('dataRenderer.locationTypeCountry')
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
		<Inline gap="sm" grow class="text-start">
			<span class="truncate text-left text-xs font-normal transition-all">
				{value.formatted_address}
			</span>
			{#if !value.geometry}
				<span class="shrink-0 text-xs font-normal text-orange-600 transition-all"
					>{t('dataRenderer.noCoordinates')}</span
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
				<Badge variant="outline" class="max-w-[200px] gap-1">
					<Icon
						icon={geoValue.geometry ? 'lucide:map-pin' : 'lucide:map-pin-off'}
						class={`h-3 w-3 shrink-0 ${geoValue.geometry ? 'text-success' : 'text-orange-500'}`}
					/>
					<span class="truncate text-xs">
						{geoValue?.formatted_address || t('dataRenderer.unknownLocation')}
					</span>
					{#if !readonly && multiple}
						<button
							type="button"
							class="ml-1 rounded-full hover:bg-secondary focus:ring-2 focus:ring-brand focus:outline-none"
							onclick={(e) => handleLocationRemove(geoValue, e)}
							aria-label={t('dataRenderer.removeLocation', {
								location: geoValue.formatted_address
							})}
						>
							<Icon icon="lucide:x" class="h-3 w-3" />
						</button>
					{/if}
				</Badge>
			{/each}

			{#if addresses.length > 2}
				<Badge variant="info" class="gap-1">
					<Icon icon="lucide:more-horizontal" class="h-3 w-3" />
					<span class="text-xs">
						{t('misc.moreItems', { count: addresses.length - 2 })}
					</span>
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
				<p class="truncate text-meta">
					{location.geometry
						? formatCoordinates(location.geometry)
						: t('dataRenderer.noCoordinatesAvailable')}
				</p>
			</div>
		</Inline>

		{#if location.geometry}
			<Stack gap="sm" fill class="p-2">
				<Inline gap="sm" class="text-sm font-medium text-secondary-foreground">
					<Icon icon="lucide:map" class="h-4 w-4" />
					{t('dataRenderer.locationMap')}
				</Inline>
				<StaticMap
					markers={[
						{ latitude: location.geometry.lat, longitude: location.geometry.lon, label: 'A' }
					]}
					ariaLabel={t('dataRenderer.mapOf', { location: location.formatted_address })}
					class="h-[12.5rem]"
				/>
			</Stack>
		{/if}

		<Stack gap="sm" fill class="p-2">
			<Inline gap="sm" class="text-sm font-medium text-secondary-foreground">
				<Icon icon="lucide:info" class="h-4 w-4" />
				{t('dataRenderer.locationDetails')}
			</Inline>
			<Stack gap="xs" class="pl-6">
				<p class="font-mono text-xs text-muted-foreground">
					{#if location.geometry}
						{t('dataRenderer.latitude')}: {location.geometry.lat.toFixed(6)}°
						<br />
						{t('dataRenderer.longitude')}: {location.geometry.lon.toFixed(6)}°
						<br />
						SRID: {location.srid}
					{:else}
						{t('dataRenderer.noCoordinatesForLocation')}
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
							{t('dataRenderer.geocoded')}
						</Inline>
					{:else}
						<Inline
							as="span"
							gap="xs"
							class="rounded-full bg-orange-100 px-2 py-1 text-xs text-orange-800"
						>
							<Icon icon="lucide:alert-triangle" class="h-3 w-3" />
							{t('dataRenderer.noCoordinatesAvailable')}
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
							{t('dataRenderer.gpsCompatible')}
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
		<Stack gap="sm" align="center" class="py-8 text-center text-muted-foreground">
			<Icon icon="lucide:map-pin-off" class="h-8 w-8 text-muted-foreground" />
			<p class="text-sm">{t('dataRenderer.noLocations')}</p>
		</Stack>
	{/if}
{/snippet}

<Combobox
	type="server"
	class={className ? `${className} group` : 'group'}
	{value}
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
	searchPlaceholder={t('dataRenderer.typeToSearchLocations')}
	{multiple}
	{emptyPlaceholder}
	{...restProps}
/>

{#snippet emptyPlaceholder()}
	<Inline gap="sm" class="text-meta">
		<Icon icon="lucide:map-pin-off" class="h-6 w-6" />
		<p>{t('dataRenderer.noLocations')}</p>
	</Inline>
{/snippet}
