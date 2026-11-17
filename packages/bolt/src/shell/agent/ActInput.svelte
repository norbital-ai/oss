<!-- Generated writes in their own terms: one compact action/count, with row details only when opened. -->
<script lang="ts">
	import { Icon, StructuredData, type UiContext } from '@norbital-ai/ui';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Json } from '../../decl/values.ts';
	import { callableWords } from './view.ts';
	import ReadTable from './ReadTable.svelte';
	let { ctx, input, t }: { ctx: UiContext; input: Json; t: (key: string) => string } = $props();
	const object = (v: Json | undefined): v is { readonly [key: string]: Json } =>
		typeof v === 'object' && v !== null && !Array.isArray(v);
	const acts = $derived(
		object(input) && object(input['acts']) ? Object.entries(input['acts']) : []
	);
	const opened = new SvelteSet<string>();
</script>

<div class="grid min-w-0 gap-1" data-act-input>
	{#each acts as [callable, value] (callable)}
		{@const count = Array.isArray(value)
			? value.length
			: object(value) && Array.isArray(value['rows'])
				? value['rows'].length
				: null}
		<details
			class="group/act min-w-0 rounded-md border border-border/70"
			ontoggle={(e) => (e.currentTarget.open ? opened.add(callable) : opened.delete(callable))}
		>
			<summary
				class="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2 py-1 text-xs [&::-webkit-details-marker]:hidden"
			>
				<Icon name="lucide:square-pen" class="size-3.5 shrink-0 text-muted-foreground" />
				<span class="min-w-0 flex-1">{t(callableWords(callable))}</span>
				{#if count !== null}<span class="shrink-0 tabular-nums text-muted-foreground"
						>{count} {t(count === 1 ? 'row' : 'rows')}</span
					>{/if}
				<Icon
					name="lucide:chevron-right"
					class="size-3 shrink-0 text-muted-foreground group-open/act:rotate-90"
				/>
			</summary>
			{#if opened.has(callable)}<div
					class="max-h-56 min-w-0 overflow-auto border-t border-border/70 p-1"
				>
					{#if Array.isArray(value)}<ReadTable {ctx} {t} value={{ [callable]: value }} />
					{:else}<StructuredData
							{ctx}
							{value}
							name={t(callableWords(callable))}
							frame={false}
						/>{/if}
				</div>{/if}
		</details>
	{/each}
</div>
