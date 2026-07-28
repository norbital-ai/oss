<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { overtimeAwardSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type AwardKind = Value['kind'];

	const KIND_OPTIONS: { value: AwardKind; label: string; description: string }[] = [
		{
			value: 'HOURLY_MULTIPLE',
			label: 'Hourly multiple',
			description: 'Multiple of the hourly ordinary rate'
		},
		{
			value: 'DAY_WAGE_MULTIPLE',
			label: 'Day-wage multiple',
			description: 'Multiple of the ordinary day wage'
		}
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(overtimeAwardSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.kind === 'HOURLY_MULTIPLE'
			? `${current.multiple} × hourly rate`
			: `${current.multiple} × day wage`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: AwardKind): Value {
		switch (kind) {
			case 'HOURLY_MULTIPLE':
				return { kind: 'HOURLY_MULTIPLE', multiple: 1.5 };
			case 'DAY_WAGE_MULTIPLE':
				return { kind: 'DAY_WAGE_MULTIPLE', multiple: 1 };
		}
	}

	function selectKind(kind: AwardKind | null): void {
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
			Award
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select an award"
				onValueChange={selectKind}
			/>
		</label>
		{#if current !== null}
			<label class="grid gap-1.5 text-sm font-medium">
				Multiple
				<Input
					type="number"
					min="0.01"
					step="0.05"
					value={current.multiple}
					{disabled}
					oninput={(event) =>
						emit({ ...current, multiple: numberFrom(event.currentTarget.value, 1) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
