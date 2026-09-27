<!--
@component
A dense, filterable log: one line per event, oldest first, following the tail and loading older pages on request.
-->
<script lang="ts" module>
	import type { LogLine } from './logs.js';

	/** The props of `LogView`. */
	export type LogViewProps = {
		/** Oldest first; new events append. */
		rows: readonly LogLine[];
		/** Loads the next older page (the caller holds the cursor) and prepends it to `rows`. */
		loadOlder?: () => Promise<unknown>;
		hasOlder?: boolean;
		/** Keep the newest line in view; scrolling up pauses it. */
		follow?: boolean;
		locale?: string;
		class?: string;
	};
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { watch } from 'runed';
	import { cn } from '../primitives/utils.js';
	import { offsets, windowOf } from '../primitives/virtual/virtual.js';
	import { LOG_LEVELS, ROW_ESTIMATE, atBottom, filterLogs, wantsOlder, type LogLevel } from './logs.js';

	let { rows, loadOlder, hasOlder = false, follow = $bindable(true), locale, class: className }: LogViewProps = $props();

	let hidden = $state<Partial<Record<LogLevel, boolean>>>({});
	let q = $state('');
	let heights = $state<Record<string, number>>({});
	let port = $state<HTMLDivElement>();
	let scrollTop = $state(0);
	let viewport = $state(0);
	let loading = $state(false);

	const shown = $derived(filterLogs(rows, hidden, q));
	const offs = $derived(offsets(shown.map((r) => heights[r.id] || ROW_ESTIMATE)));
	const total = $derived(offs[offs.length - 1]);
	const win = $derived(windowOf(offs, scrollTop, viewport));
	const time = $derived(
		new Intl.DateTimeFormat(locale, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
	);
	const BADGE: Record<LogLevel, string> = {
		debug: 'text-muted-foreground',
		info: 'text-sky-600 dark:text-sky-400',
		warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
		error: 'bg-red-500/15 text-red-700 dark:text-red-400'
	};

	const toBottom = () => port && (port.scrollTop = port.scrollHeight);
	watch([() => total, () => follow], () => {
		if (follow) toBottom();
	});

	async function older() {
		if (!port || !loadOlder) return;
		loading = true;
		const before = total;
		try {
			await loadOlder();
			await tick();
			// keep the line under the reader where it was: the prepended page grows the content above it
			port.scrollTop += total - before;
		} finally {
			loading = false;
		}
	}

	function onscroll() {
		if (!port) return;
		scrollTop = port.scrollTop;
		follow = atBottom(port);
		if (wantsOlder(scrollTop, hasOlder && !!loadOlder, loading)) void older();
	}
</script>

<div class={cn('flex min-h-0 flex-col overflow-hidden rounded-md border bg-card', className)} data-log-view>
	<div class="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
		{#each LOG_LEVELS as level (level)}
			<button
				type="button"
				aria-pressed={!hidden[level]}
				onclick={() => (hidden[level] = !hidden[level])}
				class={cn('h-6 rounded px-2 font-mono text-[11px] uppercase', hidden[level] ? 'text-muted-foreground/60 line-through' : BADGE[level])}
			>{level}</button>
		{/each}
		{#if loading}<span class="text-muted-foreground text-xs">Loading older…</span>{/if}
		<input bind:value={q} type="search" placeholder="Filter…" aria-label="Filter logs" class="h-7 min-w-32 flex-1 rounded border bg-background px-2 text-xs" />
		<button
			type="button"
			aria-pressed={follow}
			onclick={() => (follow = !follow)}
			class={cn('h-7 rounded border px-2 text-xs', follow && 'bg-foreground text-background')}
		>{follow ? 'Following' : 'Follow'}</button>
	</div>
	<div bind:this={port} bind:clientHeight={viewport} {onscroll} role="log" aria-live="off" class="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5">
		<div class="relative" style:height="{total}px">
			<div class="absolute inset-x-0 top-0" style:transform="translateY({offs[win.start]}px)">
				{#each shown.slice(win.start, win.end) as row (row.id)}
					<div bind:offsetHeight={heights[row.id]} class="hover:bg-muted/50 grid grid-cols-[auto_3.5rem_minmax(0,1fr)] items-start gap-x-3 px-3 py-px" data-log-level={row.level}>
						<time class="text-muted-foreground whitespace-nowrap tabular-nums" datetime={new Date(row.at).toISOString()}>{time.format(new Date(row.at))}</time>
						<span class={cn('rounded px-1 text-center text-[10px] uppercase', BADGE[row.level])}>{row.level}</span>
						<span class="whitespace-pre-wrap break-words">{#if row.source}<span class="text-muted-foreground">{row.source} </span>{/if}{row.message}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
