<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { holidayScopeSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type ScopeKind = Value['kind'];

	const KIND_OPTIONS: { value: ScopeKind; label: string; description: string }[] = [
		{ value: 'NATIONAL', label: 'National', description: 'Applies to every location' },
		{ value: 'REGIONAL', label: 'Regional', description: 'Applies to named locations only' }
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(holidayScopeSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.kind === 'NATIONAL' ? 'National' : current.location_codes.join(', ');
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: ScopeKind): Value {
		switch (kind) {
			case 'NATIONAL':
				return { kind: 'NATIONAL' };
			case 'REGIONAL':
				return { kind: 'REGIONAL', location_codes: [] };
		}
	}

	function selectKind(kind: ScopeKind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(defaultFor(kind));
	}

	function splitCodes(raw: string): string[] {
		return raw
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Scope
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select a scope"
				onValueChange={selectKind}
			/>
		</label>
		{#if current?.kind === 'REGIONAL'}
			<label class="grid gap-1.5 text-sm font-medium">
				Location codes (comma separated)
				<Input
					value={current.location_codes.join(', ')}
					{disabled}
					placeholder="MY-10, MY-14"
					oninput={(event) =>
						emit({ kind: 'REGIONAL', location_codes: splitCodes(event.currentTarget.value) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
