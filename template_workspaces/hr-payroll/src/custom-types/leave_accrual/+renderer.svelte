<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { leaveAccrualSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type AccrualKind = Value['kind'];
	type Carry = { limit_days: number; expiry_months: number };

	const KIND_OPTIONS: { value: AccrualKind; label: string; description: string }[] = [
		{ value: 'MONTHLY', label: 'Monthly', description: 'Pro-rata each completed month' },
		{ value: 'UPFRONT', label: 'Upfront', description: 'Whole band at the leave-year start' },
		{ value: 'PER_EVENT', label: 'Per event', description: 'No balance — granted per request' }
	];

	const DEFAULT_CARRY: Carry = { limit_days: 0, expiry_months: 0 };

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(leaveAccrualSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.kind === 'PER_EVENT') return 'Per event';
		const carry =
			current.carry === null
				? 'no carry forward'
				: `carry ${current.carry.limit_days}d / expires ${current.carry.expiry_months}m`;
		return `${current.kind === 'MONTHLY' ? 'Monthly' : 'Upfront'} · ${carry}`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: AccrualKind): Value {
		switch (kind) {
			case 'MONTHLY':
				return { kind: 'MONTHLY', carry: null };
			case 'UPFRONT':
				return { kind: 'UPFRONT', carry: null };
			case 'PER_EVENT':
				return { kind: 'PER_EVENT' };
		}
	}

	function selectKind(kind: AccrualKind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(defaultFor(kind));
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
			Accrual
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select an accrual"
				onValueChange={selectKind}
			/>
		</label>

		{#if current?.kind === 'MONTHLY' || current?.kind === 'UPFRONT'}
			<label class="flex items-center gap-2 self-end text-sm font-medium">
				<input
					type="checkbox"
					class="size-4"
					checked={current.carry !== null}
					{disabled}
					onchange={(event) =>
						emit({ ...current, carry: event.currentTarget.checked ? DEFAULT_CARRY : null })}
				/>
				Carry forward
			</label>

			{#if current.carry !== null}
				{@const carry = current.carry}
				<label class="grid gap-1.5 text-sm font-medium">
					Carry limit (days)
					<Input
						type="number"
						min="0"
						step="0.5"
						value={carry.limit_days}
						{disabled}
						oninput={(event) =>
							emit({
								...current,
								carry: { ...carry, limit_days: numberFrom(event.currentTarget.value, 0) }
							})}
					/>
				</label>
				<label class="grid gap-1.5 text-sm font-medium">
					Expires after (months)
					<Input
						type="number"
						min="0"
						step="1"
						value={carry.expiry_months}
						{disabled}
						oninput={(event) =>
							emit({
								...current,
								carry: { ...carry, expiry_months: numberFrom(event.currentTarget.value, 0) }
							})}
					/>
				</label>
			{/if}
		{/if}
	</Grid>
{/if}
