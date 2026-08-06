<script lang="ts">
	/**
	 * Half-hour-stepped **hours** input over an integer **minutes** column.
	 *
	 * `shift_definitions.break_minutes`, `shift_definitions.overtime_break_minutes` and
	 * `time_entries.break_minutes` all stay `integer()` minutes: that is the unit the overtime
	 * engine, the roster validation, the payroll export and the customer time-entries workbook all
	 * measure in, and 0.5 h is exactly 30 min, so the conversion is lossless in both directions. Only
	 * what the operator types and reads is hours.
	 *
	 * `oninput` emits the typed value untouched so a half-finished "0.75" is never snapped out from
	 * under the caret; `onchange` — which fires when the field is committed — snaps to the half hour.
	 * A value already stored off the step (a legacy 45 min) survives display and is only rounded once
	 * the operator actually edits it.
	 */
	import { Input } from '@norbital-ai/ui/input';
	import type { CollectionFormRendererProps } from '@norbital-ai/ui/collection-form';

	/** One step of the input, in stored minutes. */
	const STEP_MINUTES = 30;

	let props: CollectionFormRendererProps = $props();

	const minutes = $derived(Number(props.value));
	const hours = $derived(Number.isFinite(minutes) ? String(minutes / 60) : '');

	function emitHours(raw: string, snap: boolean): void {
		if (raw.trim().length === 0) {
			props.onValueChange(0);
			return;
		}
		const typed = Number(raw);
		if (!Number.isFinite(typed) || typed < 0) return;
		const asMinutes = typed * 60;
		props.onValueChange(
			snap ? Math.round(asMinutes / STEP_MINUTES) * STEP_MINUTES : Math.round(asMinutes)
		);
	}
</script>

<Input
	type="number"
	min="0"
	step="0.5"
	value={hours}
	disabled={props.disabled || props.readonly}
	placeholder={props.placeholder}
	oninput={(event) => emitHours(event.currentTarget.value, false)}
	onchange={(event) => emitHours(event.currentTarget.value, true)}
/>
