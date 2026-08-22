<script lang="ts">
	import { Schema } from 'effect';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import DateView from './views/date.view.svelte';

	/** Canonical range shape; `lower`/`upper` under the same keys is tstzrange's legacy wire form. */
	const rangeValueSchema = Schema.Struct({
		start: Schema.optionalKey(Schema.String),
		end: Schema.optionalKey(Schema.String)
	});
	const decodeCanonicalRange = Schema.decodeUnknownResult(rangeValueSchema);
	const decodeLegacyRange = Schema.decodeUnknownResult(
		Schema.Struct({
			lower: Schema.optionalKey(Schema.String),
			upper: Schema.optionalKey(Schema.String)
		})
	);
	type RangeValue = typeof rangeValueSchema.Type;

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	const valuePlaceholderText = t('dataRenderer.valuePlaceholder');

	function parseRange(item: unknown): RangeValue {
		if (item != null && typeof item === 'object') {
			const canonical = decodeCanonicalRange(item);
			if (canonical._tag === 'Success') return canonical.success;
			const legacy = decodeLegacyRange(item);
			return legacy._tag === 'Success'
				? { start: legacy.success.lower, end: legacy.success.upper }
				: {};
		}
		// PostgreSQL's own tstzrange literal grammar (a bound pair in brackets), not a data shape.
		if (typeof item !== 'string' || item === 'empty') return {};
		const match = item.match(/^[[(]\"?([^,\"]*)\"?,\"?([^\]\)\"]*)\"?[\])]$/);
		return match ? { start: match[1] || undefined, end: match[2] || undefined } : {};
	}

	const pickerValue = $derived.by((): RangeValue | RangeValue[] =>
		field.array && Array.isArray(value) ? value.map(parseRange) : parseRange(value)
	);
</script>

{#if field.array}
	<DateView
		value={Array.isArray(pickerValue) ? pickerValue : []}
		multi={true}
		allowTime={field.kind === 'tstzrange'}
		emptyPlaceholder={placeholder === valuePlaceholderText
			? t('dataRenderer.pickDateRanges')
			: placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{:else}
	<DateView
		value={!Array.isArray(pickerValue) ? pickerValue : {}}
		multi={false}
		allowTime={field.kind === 'tstzrange'}
		emptyPlaceholder={placeholder === valuePlaceholderText
			? t('dataRenderer.pickDateRanges')
			: placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
