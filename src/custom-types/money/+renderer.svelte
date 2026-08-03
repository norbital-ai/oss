<script lang="ts">
	import { formatDataValue } from '@norbital-ai/ui/data-renderer';
	import { MoneyRenderer } from '@norbital-ai/ui/data-renderer/money';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import type { RendererProps } from './$types.js';

	let props: RendererProps = $props();
	const allowedCurrencies = $derived.by((): readonly string[] | undefined => {
		const candidate = props.field.options?.allowedCurrencies;
		return Array.isArray(candidate) && candidate.every((currency) => typeof currency === 'string')
			? candidate
			: undefined;
	});
	const field = $derived({
		...props.field,
		currencies: allowedCurrencies
	} satisfies CollectionField);
</script>

{#if props.mode === 'edit'}
	<MoneyRenderer
		{field}
		value={props.value}
		mode="edit"
		disabled={props.disabled}
		onValueChange={props.onValueChange}
	/>
{:else}
	<span class="block truncate" title={formatDataValue(field, props.value)}>
		{formatDataValue(field, props.value)}
	</span>
{/if}
