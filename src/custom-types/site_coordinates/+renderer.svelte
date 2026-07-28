<script lang="ts">
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import type { RendererProps, Value } from './$types.js';
	import { siteCoordinatesSchema } from './+definition.js';

	const axes = ['x', 'y', 'z'] as const;

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(siteCoordinatesSchema.safeParse(props.value));
	const coordinates = $derived(parsed.success ? parsed.data : { x: null, y: null, z: null });

	function numberOrNull(value: string): number | null {
		return value === '' ? null : Number(value);
	}

	function update(patch: Partial<Value>): void {
		if (props.mode !== 'edit') return;
		const next = { ...coordinates, ...patch };
		props.onValueChange(Object.values(next).some((value) => value != null) ? next : null);
	}
</script>

<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
	{#each axes as axis (axis)}
		<label class="grid gap-1.5 text-sm font-medium">
			{axis.toUpperCase()}
			<Input
				type="number"
				step="any"
				value={coordinates[axis] ?? ''}
				{disabled}
				oninput={(event) => update({ [axis]: numberOrNull(event.currentTarget.value) })}
			/>
		</label>
	{/each}
</Grid>
