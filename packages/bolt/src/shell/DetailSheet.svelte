<!--
	A system row opened from its table : ui's `Sheet` with the row's actions, its fields as a
	label/value grid and structured values through the shared schema renderer and any editor the page adds below. A `footer`
	sits flush at the bottom, as a record's Edit / Save does.
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
		footer,
		on_close
	}: {
		title: string;
		fields?: readonly { label: string; value: Json | undefined; kind?: Kind }[];
		acts?: readonly Act[];
		summary?: Snippet;
		children?: Snippet;
		footer?: Snippet;
		on_close: () => void;
	} = $props();
	const details = $derived(fields.filter((field) => field.value !== undefined));
</script>

<Sheet
	open
	{title}
	on_open_change={(open) => {
		if (!open) on_close();
	}}
>
	<div class={['flex min-w-0 flex-col gap-4', footer && 'h-full min-h-0']}>
		<div class={['flex min-w-0 flex-col gap-4', footer && 'min-h-0 flex-1 overflow-auto']}>
			<Acts {acts} all />
			{#if summary}{@render summary()}{/if}
			{#if details.length > 0}<dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{#each details as f (f.label)}
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
				</dl>{/if}
			{#if children}{@render children()}{/if}
		</div>
		{#if footer}<footer
				class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-3"
				data-detail-foot
			>
				{@render footer()}
			</footer>{/if}
	</div>
</Sheet>
