<!--
@component
A compact vertical timeline: each entry a small action icon and one subtle line (what · who · when), its payload (a
reason, changed fields) quietly below. The approval panel's history and the record history pane both read as this.
-->
<script lang="ts">
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { TIMELINE_ICON, type TimelineEntry } from './timeline.js';

	let {
		entries,
		label
	}: {
		/** Newest or oldest first, as the owner orders them. */
		entries: readonly TimelineEntry[];
		/** The list's accessible name. */
		label?: string;
	} = $props();
</script>

<ol class="flex flex-col" aria-label={label} data-timeline>
	{#each entries as e, i (e.key)}
		{@const future = e.status === 'future' || entries[i + 1]?.status === 'future' || entries[i + 1]?.status === 'active'}
		<li
			class={['relative flex gap-2.5 pb-3 last:pb-0', e.status === 'future' && 'opacity-65']}
			data-action={e.action}
			data-status={e.status}
			{...e.data}
		>
			{#if i < entries.length - 1}<span
					aria-hidden="true"
					class={[
						'absolute top-6 bottom-0 left-2.5 w-px',
						future ? 'border-border border-l border-dashed' : 'bg-border'
					]}
				></span>{/if}
			<span
				class={[
					'bg-background relative grid size-5 shrink-0 place-items-center rounded-full border',
					e.status === 'active'
						? 'border-brand text-brand'
						: e.status === 'changes'
							? 'border-warning text-warning-foreground dark:text-warning'
							: e.status === 'future'
								? 'border-dashed text-muted-foreground'
								: e.current
									? 'border-brand text-brand'
									: 'text-muted-foreground'
				]}
				data-icon-action={e.action}
			>
				{#if e.status === 'active'}<span
						class="bg-brand/30 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none"
						aria-hidden="true"
					></span><span class="bg-brand size-2 rounded-full" aria-hidden="true"></span>
				{:else}<Glyph name={TIMELINE_ICON[e.action]} class="size-3" />{/if}
			</span>
			{#if e.onpick}<button
					type="button"
					aria-current={e.current ? 'true' : undefined}
					data-pick
					class="hover:bg-muted focus-visible:ring-ring/40 -mx-1.5 -my-0.5 min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left focus-visible:ring-2 focus-visible:outline-none"
					onclick={e.onpick}
				>
					{@render body(e)}
				</button>
			{:else}<div class="min-w-0 flex-1">{@render body(e)}</div>{/if}
		</li>
	{/each}
</ol>

{#snippet body(e: TimelineEntry)}
	<span class="text-meta flex min-h-5 items-center gap-2">
		<span class="min-w-0 flex-1 truncate" data-line>{e.line.join(' · ')}</span>
		{#if e.mark}<span
				class={['shrink-0', e.mark.warn ? 'text-warning-foreground dark:text-warning' : 'text-brand-text']}
				data-mark>{e.mark.text}</span
			>{/if}
	</span>
	{#if e.quote}<span class="text-meta block whitespace-pre-wrap wrap-anywhere italic" data-reason
			>“{e.quote}”</span
		>{/if}
	{#each e.notes ?? [] as note (note.kind)}<span
			class={['text-meta block wrap-anywhere', note.warn && 'text-warning-foreground dark:text-warning']}
			data-note={note.kind}>{note.text}</span
		>{/each}
{/snippet}
