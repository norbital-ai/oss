<!--
@component
A vertical timeline for chronological series: approval logs, revision history, dated contracts/facts, change logs,
and activity streams. Each entry is an icon node on a shared rail with a header line and optional expandable or
always-visible content below.
-->
<script lang="ts" generics="T extends TimelineEntry = TimelineEntry">
	import type { Snippet } from 'svelte';
	import Badge from '../primitives/badge/badge.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import { virtual_list } from '../primitives/virtual/virtual.svelte.js';
	import { TIMELINE_ICON, type TimelineEntry, type TimelineTone } from './timeline.js';

	let {
		entries,
		label,
		item,
		trailing,
		empty
	}: {
		/** Newest or oldest first, as the owner orders them. */
		entries: readonly T[];
		/** The list's accessible name. */
		label?: string;
		/** Optional body rendered under an entry's header (shown only while `expanded` when disclosure is enabled). */
		item?: Snippet<[T]>;
		/** Optional trailing controls on the entry header row, outside its pick/toggle button. */
		trailing?: Snippet<[T]>;
		/** Shown when `entries` is empty. */
		empty?: Snippet;
	} = $props();

	const TONE_CLASS: Readonly<Record<TimelineTone, string>> = {
		default: 'text-muted-foreground',
		brand: 'border-brand text-brand',
		info: 'border-tone-info-border text-tone-info-text',
		success: 'border-tone-success-border text-tone-success-text',
		warning: 'border-tone-warning-border text-tone-warning-text',
		danger: 'border-tone-danger-border text-tone-danger-text'
	};

	const nodeClass = (e: TimelineEntry): string => {
		if (e.status === 'active') return 'border-brand text-brand';
		if (e.status === 'changes') return 'border-tone-warning-border text-tone-warning-text';
		if (e.status === 'future') return 'border-dashed text-muted-foreground';
		if (e.tone !== undefined) return TONE_CLASS[e.tone];
		return e.current ? 'border-brand text-brand' : 'text-muted-foreground';
	};
	const win = virtual_list({
		count: () => entries.length,
		key: (i) => entries[i]?.key ?? String(i),
		estimate: 56,
		threshold: 40,
		overscan: 8
	});
</script>

{#if entries.length === 0}
	{#if empty}{@render empty()}{/if}
{:else}
	<ol class="flex flex-col" aria-label={label} data-timeline>
		{#if win.on}
			<li aria-hidden="true" class="shrink-0" {@attach win.anchor} style:height="{win.before}px"></li>
		{/if}
		{#each win.slice(entries) as e, j (e.key)}
			{@const i = win.start + j}
			{@const future =
				e.status === 'future' ||
				entries[i + 1]?.status === 'future' ||
				entries[i + 1]?.status === 'active'}
			{@const expandable = e.expanded !== undefined && e.ontoggle !== undefined}
			{@const showItem = item !== undefined && (e.expanded === undefined || e.expanded)}
			<li
				class={['relative flex gap-2.5 pb-3 last:pb-0', e.status === 'future' && 'opacity-65']}
				data-action={e.action}
				data-status={e.status}
				data-tone={e.tone}
				{...e.data}
				{@attach win.measure(e.key)}
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
						nodeClass(e)
					]}
					data-icon-action={e.action}
				>
					{#if e.status === 'active'}<span
							class="bg-brand/30 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none"
							aria-hidden="true"
						></span><span class="bg-brand size-2 rounded-full" aria-hidden="true"></span>
					{:else if e.icon !== undefined}<Icon name={e.icon} class="size-3" />
					{:else}<Glyph name={TIMELINE_ICON[e.action ?? 'step']} class="size-3" />{/if}
				</span>
				<div class="min-w-0 flex-1">
					<div class="flex min-w-0 items-start gap-2">
						{#if expandable}
							<button
								type="button"
								aria-expanded={e.expanded ? 'true' : 'false'}
								aria-current={e.current ? 'true' : undefined}
								data-toggle
								class="hover:bg-muted focus-visible:ring-ring/40 -mx-1.5 -my-0.5 flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-0.5 text-left focus-visible:ring-2 focus-visible:outline-none"
								onclick={e.ontoggle}
							>
								<Glyph
									name="right"
									class={e.expanded
										? 'text-muted-foreground mt-0.5 size-3.5 shrink-0 rotate-90 transition-transform'
										: 'text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform'}
								/>
								<span class="min-w-0 flex-1">{@render header(e)}</span>
							</button>
						{:else if e.onpick}
							<button
								type="button"
								aria-current={e.current ? 'true' : undefined}
								data-pick
								class="hover:bg-muted focus-visible:ring-ring/40 -mx-1.5 -my-0.5 min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left focus-visible:ring-2 focus-visible:outline-none"
								onclick={e.onpick}
							>
								{@render header(e)}
							</button>
						{:else}
							<div class="min-w-0 flex-1">{@render header(e)}</div>
						{/if}
						{#if trailing}<div class="shrink-0">{@render trailing(e)}</div>{/if}
					</div>
					{#if showItem}
						<div class="mt-2 min-w-0" data-timeline-body>
							{@render item(e)}
						</div>
					{/if}
				</div>
			</li>
		{/each}
		{#if win.on && win.after > 0}
			<li aria-hidden="true" class="shrink-0" style:height="{win.after}px"></li>
		{/if}
	</ol>
{/if}

{#snippet header(e: T)}
	{@const parts = e.line ?? []}
	{#if e.title !== undefined}
		<span class="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-0.5">
			<span class="text-foreground text-sm font-medium" data-title>{e.title}</span>
			{#if parts.length > 0}<span class="text-meta min-w-0 truncate" data-line
					>{parts.join(' · ')}</span
				>{/if}
			{#if e.mark}
				{#if e.mark.variant !== undefined}<Badge variant={e.mark.variant} data-mark
						>{e.mark.text}</Badge
					>
				{:else}<span
						class={['text-meta ml-auto shrink-0', e.mark.warn ? 'text-tone-warning-text' : 'text-brand-text']}
						data-mark>{e.mark.text}</span
					>{/if}
			{/if}
		</span>
	{:else}
		<span class="text-meta flex min-h-5 items-center gap-2">
			<span class="min-w-0 flex-1 truncate" data-line>{parts.join(' · ')}</span>
			{#if e.mark}
				{#if e.mark.variant !== undefined}<Badge variant={e.mark.variant} data-mark
						>{e.mark.text}</Badge
					>
				{:else}<span
						class={['shrink-0', e.mark.warn ? 'text-tone-warning-text' : 'text-brand-text']}
						data-mark>{e.mark.text}</span
					>{/if}
			{/if}
		</span>
	{/if}
	{#if e.quote}<span class="text-meta block whitespace-pre-wrap wrap-anywhere italic" data-reason
			>“{e.quote}”</span
		>{/if}
	{#each e.notes ?? [] as note (note.kind)}<span
			class={['text-meta block wrap-anywhere', note.warn && 'text-tone-warning-text']}
			data-note={note.kind}>{note.text}</span
		>{/each}
{/snippet}
