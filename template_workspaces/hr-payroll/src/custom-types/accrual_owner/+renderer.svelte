<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { accrualOwnerSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type Level = Value['level'];

	const LEVEL_OPTIONS: { value: Level; label: string; description: string }[] = [
		{
			value: 'STATUTORY',
			label: 'Statutory',
			description: 'The jurisdiction minimum entitlement'
		},
		{ value: 'COMPANY', label: 'Company', description: 'A company policy band' }
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(accrualOwnerSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.level === 'STATUTORY'
			? `Statutory · ${current.jurisdiction_id}`
			: `Company · ${current.company_id}`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(level: Level): Value {
		switch (level) {
			case 'STATUTORY':
				return { level: 'STATUTORY', jurisdiction_id: '' };
			case 'COMPANY':
				return { level: 'COMPANY', company_id: '' };
		}
	}

	function selectLevel(level: Level | null): void {
		if (level === null) {
			emit(null);
			return;
		}
		if (current !== null && current.level === level) return;
		emit(defaultFor(level));
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Owner
			<Combobox
				options={LEVEL_OPTIONS}
				value={current?.level ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select an owner"
				onValueChange={selectLevel}
			/>
		</label>
		{#if current?.level === 'STATUTORY'}
			<label class="grid gap-1.5 text-sm font-medium">
				Jurisdiction id
				<Input
					value={current.jurisdiction_id}
					{disabled}
					placeholder="UUID of the jurisdiction"
					oninput={(event) =>
						emit({ level: 'STATUTORY', jurisdiction_id: event.currentTarget.value })}
				/>
			</label>
		{:else if current?.level === 'COMPANY'}
			<label class="grid gap-1.5 text-sm font-medium">
				Company id
				<Input
					value={current.company_id}
					{disabled}
					placeholder="UUID of the company"
					oninput={(event) => emit({ level: 'COMPANY', company_id: event.currentTarget.value })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
