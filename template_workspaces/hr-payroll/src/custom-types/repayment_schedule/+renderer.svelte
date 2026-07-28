<script lang="ts">
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { repaymentScheduleSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const EMPTY: Value = { instalment_amount: 0, count: 1, first_period: '' };

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(repaymentScheduleSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : EMPTY);
	const summary = $derived(
		parsed.success
			? `${current.count} × ${current.instalment_amount} from ${current.first_period}`
			: '—'
	);

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function numberFrom(raw: string, fallback: number): number {
		const next = Number(raw);
		return Number.isFinite(next) ? next : fallback;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Instalment amount
			<Input
				type="number"
				min="0.01"
				step="0.01"
				value={current.instalment_amount}
				{disabled}
				oninput={(event) =>
					emit({ ...current, instalment_amount: numberFrom(event.currentTarget.value, 0) })}
			/>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			Number of instalments
			<Input
				type="number"
				min="1"
				step="1"
				value={current.count}
				{disabled}
				oninput={(event) => emit({ ...current, count: numberFrom(event.currentTarget.value, 1) })}
			/>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			First period
			<Input
				value={current.first_period}
				{disabled}
				placeholder="YYYY-MM"
				oninput={(event) => emit({ ...current, first_period: event.currentTarget.value })}
			/>
		</label>
	</Grid>
{/if}
