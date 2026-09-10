<script lang="ts">
	import { Schema } from 'effect';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import { toStoredInstant, toViewerInstant } from '../utc-day.js';
	import DateView from './views/date.view.svelte';

	/** The picker's own range shape; the database sends a tstzrange literal instead. */
	const rangeValueSchema = Schema.Struct({
		start: Schema.optionalKey(Schema.String),
		end: Schema.optionalKey(Schema.String)
	});
	const decodeCanonicalRange = Schema.decodeUnknownResult(rangeValueSchema);
	type RangeValue = typeof rangeValueSchema.Type;

	// Bare `typeof item === 'object'` acceptance: arrays included, null excluded.
	const isObjectish = Schema.is(
		Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
	);
	const isString = Schema.is(Schema.String);

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
		if (item != null && isObjectish(item)) {
			const canonical = decodeCanonicalRange(item);
			return canonical._tag === 'Success' ? canonical.success : {};
		}
		// PostgreSQL's own tstzrange literal grammar (a bound pair in brackets), not a data shape.
		if (!isString(item) || item === 'empty') return {};
		const match = item.match(/^[[(]\"?([^,\"]*)\"?,\"?([^\]\)\"]*)\"?[\])]$/);
		return match ? { start: match[1] || undefined, end: match[2] || undefined } : {};
	}

	/**
	 * Day precision stores one canonical day per bound — midnight UTC, the prefix `bolt_instant`
	 * and `bolt_daterange` read — while the calendar works in the viewer's zone. The two transforms
	 * are applied here, at the renderer boundary, so the view never has to know.
	 */
	const dayPrecision = $derived(field.precision === 'day');

	const shownRange = (range: RangeValue): RangeValue =>
		!dayPrecision
			? range
			: {
					start: range.start == null ? range.start : (toViewerInstant(range.start) ?? range.start),
					end: range.end == null ? range.end : (toViewerInstant(range.end) ?? range.end)
				};

	const storedRange = (range: RangeValue): RangeValue =>
		!dayPrecision
			? range
			: {
					start: range.start == null ? range.start : (toStoredInstant(range.start) ?? range.start),
					end: range.end == null ? range.end : (toStoredInstant(range.end) ?? range.end)
				};

	const pickerValue = $derived.by((): RangeValue | RangeValue[] =>
		field.array && Array.isArray(value)
			? value.map((item) => shownRange(parseRange(item)))
			: shownRange(parseRange(value))
	);
</script>

{#if field.array}
	<DateView
		value={Array.isArray(pickerValue) ? pickerValue : []}
		multi={true}
		allowTime={field.precision !== 'day'}
		emptyPlaceholder={placeholder === valuePlaceholderText
			? t('dataRenderer.pickDateRanges')
			: placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next.map(storedRange))}
	/>
{:else}
	<DateView
		value={!Array.isArray(pickerValue) ? pickerValue : {}}
		multi={false}
		allowTime={field.precision !== 'day'}
		emptyPlaceholder={placeholder === valuePlaceholderText
			? t('dataRenderer.pickDateRanges')
			: placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(storedRange(next))}
	/>
{/if}
