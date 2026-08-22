<script lang="ts">
	import { MoneyValueSchema, type MoneyValue } from '@norbital-ai/std/finance';
	import { Result, Schema } from 'effect';
	import MoneyInput from './money.input.svelte';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';

	let {
		field,
		value,
		id,
		disabled = false,
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	const decodeMoney = Schema.decodeUnknownResult(MoneyValueSchema);
	const decodeMoneyArray = Schema.decodeUnknownResult(Schema.Array(MoneyValueSchema));
	const moneyValue = $derived.by((): MoneyValue | readonly MoneyValue[] | null =>
		field.array
			? Result.getOrElse(decodeMoneyArray(value), () => [])
			: Result.getOrElse(decodeMoney(value), () => null)
	);
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
