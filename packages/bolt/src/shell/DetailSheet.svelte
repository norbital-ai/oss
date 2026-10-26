<!--
	A system row opened from its table : ui's `Sheet` with the row's actions, its fields as a
	label/value grid and structured values through the shared schema renderer and any editor the page adds below.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Sheet, StructuredData, type Kind } from '@norbital-ai/ui';
	import type { Json } from '../decl/values.ts';
	import Acts, { type Act } from './Acts.svelte';
	import { displayWireValue } from './wire-value.ts';

	let {
		title,
		fields = [],
		acts = [],
		summary,
		children,
		onClose
	}: {
		title: string;
		fields?: readonly { label: string; value: Json | undefined; kind?: Kind }[];
		acts?: readonly Act[];
		summary?: Snippet;
		children?: Snippet;
		onClose: () => void;
	} = $props();
</script>

<Sheet
	open
	{title}
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<div class="flex min-w-0 flex-col gap-4">
		<Acts {acts} all />
		{#if summary}{@render summary()}{/if}
		<dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{#each fields.filter((f) => f.value !== undefined) as f (f.label)}
				<div
					data-detail-field={f.label}
					class={[
						'flex min-w-0 flex-col gap-0.5 text-sm',
						typeof f.value === 'object' && f.value !== null && 'sm:col-span-2'
					]}
				>
					<dt class="text-meta">{f.label}</dt>
					<dd class="min-w-0 wrap-anywhere">
						{#if f.kind !== undefined || (typeof f.value === 'object' && f.value !== null)}
							<div class="max-h-80 overflow-auto" data-detail-structured>
								<StructuredData
									{...f.value === undefined ? {} : { value: displayWireValue(f.value) }}
									name={f.label}
									{...f.kind === undefined ? {} : { kind: f.kind }}
								/>
							</div>
						{:else}{f.value === null || f.value === '' ? '—' : String(f.value)}{/if}
					</dd>
				</div>
			{/each}
		</dl>
		{#if children}{@render children()}{/if}
	</div>
</Sheet>
