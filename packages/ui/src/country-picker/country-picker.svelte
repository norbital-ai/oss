<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Combobox } from '#lib/combobox';
	import { Inline } from '#lib/layout';
	import { COUNTRY_CODES, COUNTRY_NAMES } from './country-data';

	const countryCode = COUNTRY_CODES;
	const countryNames = COUNTRY_NAMES;
	// Convert enum values to combobox options with flags
	const countryOptions = countryCode.map((code) => ({
		value: code,
		label: countryOptionLabel,
		search_term: countryNames[code] ?? code
	}));

	// Props
	let {
		value = $bindable(),
		disabled = false,
		error = null,
		class: className,
		multiple = false,
		onValueChange
	} = $props<{
		multiple?: boolean;
		value?: string | string[];
		disabled?: boolean;
		error?: string | null;
		class?: string;
		onValueChange?: (value: string | string[]) => void;
	}>();
</script>

{#snippet countryOptionLabel(props: string)}
	{@const name = countryNames[props.toUpperCase()] ?? props}
	<Inline gap="sm">
		<Icon icon={`flag:${props.toLowerCase()}-1x1`} class="h-4 w-6 rounded" />
		<span>{name}</span>
	</Inline>
{/snippet}

<Combobox
	bind:value
	{disabled}
	type="client"
	clientConfig={{
		isLoading: false,
		error
	}}
	{multiple}
	options={countryOptions}
	class={className}
	emptyPlaceholder="Select a country"
	sameWidth={true}
	align="start"
	{onValueChange}
/>
