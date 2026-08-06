<script lang="ts">
	import { formatDataValue } from '@norbital-ai/ui/data-renderer';
	import { MoneyRenderer } from '@norbital-ai/ui/data-renderer/money';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import type { RendererProps, Value } from './$types.js';
	import { moneySchema } from './+definition.js';
	let props: RendererProps = $props();

	/**
	 * `MoneyRenderer` types its callback as `(value: unknown) => void`. Validate at that boundary
	 * rather than widening our own prop, so an unparseable value never reaches the column.
	 */
	function emit(next: unknown): void {
		if (props.mode !== 'edit') return;
		if (next == null) {
			props.onValueChange(null);
			return;
		}
		const parsed = moneySchema().safeParse(next);
		if (parsed.success) props.onValueChange(parsed.data as Value);
	}

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
		onValueChange={(next: unknown) => emit(next)}
	/>
{:else}
	<span class="block truncate" title={formatDataValue(field, props.value)}>
		{formatDataValue(field, props.value)}
	</span>
{/if}
