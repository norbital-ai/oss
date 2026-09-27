<!--
	A system row opened from its table (staging's detail sheet): ui's `Sheet` with the row's actions, its fields as a
	label/value grid (a structured value as JSON) and any editor the page adds below.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Sheet } from '@norbital-ai/ui';
	import type { Json } from '../decl/values.ts';
	import Acts, { type Act } from './Acts.svelte';

	let { title, fields = [], acts = [], children, onClose }: {
		title: string; fields?: readonly { label: string; value: Json | undefined }[]; acts?: readonly Act[]; children?: Snippet; onClose: () => void;
	} = $props();
</script>

<Sheet open {title} onOpenChange={(open) => { if (!open) onClose(); }}>
	<div class="flex min-w-0 flex-col gap-4">
		<Acts {acts} all />
		<dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{#each fields.filter((f) => f.value !== undefined) as f (f.label)}
				<div class={['flex min-w-0 flex-col gap-0.5 text-sm', typeof f.value === 'object' && f.value !== null && 'sm:col-span-2']}>
					<dt class="text-meta">{f.label}</dt>
					<dd class="min-w-0 wrap-anywhere">
						{#if typeof f.value === 'object' && f.value !== null}<pre class="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{JSON.stringify(f.value, null, 2)}</pre>
						{:else}{f.value === null || f.value === '' ? '—' : String(f.value)}{/if}
					</dd>
				</div>
			{/each}
		</dl>
		{#if children}{@render children()}{/if}
	</div>
</Sheet>
