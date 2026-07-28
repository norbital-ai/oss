<script lang="ts">
	import MoneyInput, { type MoneyValue } from './money.input.svelte';
	import type { DataRendererProps } from '../data-renderer.types.js';

	let {
		field,
		value,
		id,
		disabled = false,
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	const moneyValue = $derived.by((): MoneyValue | MoneyValue[] | null => {
		const parse = (item: unknown): MoneyValue | null => {
			if (item == null || typeof item !== 'object') return null;
			const amount = Reflect.get(item, 'value');
			const currency = Reflect.get(item, 'currency');
			return typeof amount === 'number' && typeof currency === 'string'
				? { value: amount, currency }
				: null;
		};
		if (!field.array) return parse(value);
		return Array.isArray(value) ? value.flatMap((item) => parse(item) ?? []) : [];
	});
</script>

<MoneyInput
	{id}
	value={moneyValue}
	currencies={field.currencies}
	multiple={field.array ?? false}
	{disabled}
	class={className}
	onValueChange={(next) => onValueChange?.(next)}
/>
