<!--
@component
A dense, filterable log: one fixed-height line per event (a JSON payload previewed, highlighted and truncated), oldest first, following the tail and loading older pages on request.
-->
<script lang="ts" module>
	import { Effect } from 'effect';
	import type { LogLine } from './logs.js';

	/** The props of `LogView`. */
	export type LogViewProps = {
		/** Oldest first; new events append. */
		rows: readonly LogLine[];
		/** Loads the next older page (the caller holds the cursor) and prepends it to `rows`. */
		loadOlder?: () => Effect.Effect<unknown, Error>;
		hasOlder?: boolean;
		/** Keep the newest line in view; scrolling up pauses it. */
		follow?: boolean;
		locale?: string;
		class?: string;
	};
</script>

<script lang="ts">
	import { observeOnce } from '../effect/index.js';
	import { tick } from 'svelte';
	import { watch } from 'runed';
	import { cn } from '../primitives/utils.js';
	import ToolbarSearch from '../model/toolbar/ToolbarSearch.svelte';
	import ToolbarFilter from '../model/toolbar/ToolbarFilter.svelte';
	import { offsets, windowOf } from '../primitives/virtual/virtual.js';
	import {
		LOG_LEVELS,
		ROW_HEIGHT,
		atBottom,
		filterLogs,
		logPreview,
		wantsOlder,
		type LogLevel
	} from './logs.js';

	let {
		rows,
		loadOlder,
		hasOlder = false,
		follow = $bindable(true),
		locale,
		class: className
	}: LogViewProps = $props();

	let hidden = $state<Partial<Record<LogLevel, boolean>>>({});
	let q = $state('');
	let port = $state<HTMLDivElement>();
	let scrollTop = $state(0);
	let viewport = $state(0);
	let olderRequest = $state.raw<{
		load: NonNullable<LogViewProps['loadOlder']>;
		port: HTMLDivElement;
		before: number;
	} | null>(null);
	const olderPage = observeOnce(() => {
		const request = olderRequest;
		return request === null || request.load !== loadOlder
			? null
			: request.load().pipe(
					Effect.andThen(Effect.tryPromise(tick)),
					Effect.tap(() =>
						Effect.sync(() => {
							if (port === request.port) request.port.scrollTop += total - request.before;
						})
					)
				);
	});
	const loading = $derived(olderPage.loading);
	const notice = $derived(olderPage.error?.message ?? null);

	const shown = $derived(filterLogs(rows, hidden, q));
	const offs = $derived(offsets(shown.map(() => ROW_HEIGHT)));
	const total = $derived(offs[offs.length - 1]);
	const win = $derived(windowOf(offs, scrollTop, viewport));
	const time = $derived(
		new Intl.DateTimeFormat(locale, {
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		})
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

	function older() {
		if (port === undefined || loadOlder === undefined || loading) return;
		olderRequest = { load: loadOlder, port, before: total };
	}

	function onscroll() {
		if (!port) return;
		scrollTop = port.scrollTop;
		follow = atBottom(port);
		if (wantsOlder(scrollTop, hasOlder && !!loadOlder, loading)) void older();
	}
</script>

<div
	class={cn('flex min-h-0 flex-col overflow-hidden rounded-md border bg-card', className)}
	data-log-view
>
	<div class="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
		<ToolbarSearch bind:value={q} label="Search log messages" />
		<ToolbarFilter
			count={LOG_LEVELS.filter((level) => hidden[level]).length}
			label="Filter log levels"
			panelClass="w-64"
		>
			<h3 class="text-sm font-medium">Log levels</h3>
			<div class="flex flex-wrap gap-1.5">
				{#each LOG_LEVELS as level (level)}
					<button
						type="button"
						aria-pressed={!hidden[level]}
						onclick={() => (hidden[level] = !hidden[level])}
						class={cn(
							'h-8 max-sm:min-h-11 rounded px-2 font-mono text-micro uppercase',
							hidden[level] ? 'text-muted-foreground/60 line-through' : BADGE[level]
						)}>{level}</button
					>
				{/each}
			</div>
		</ToolbarFilter>
		{#if loading}<span class="text-muted-foreground text-xs">Loading older…</span>{/if}
		{#if notice}<span role="alert" class="text-destructive text-xs">{notice}</span>{/if}
		<span class="flex-1"></span>
		<button
			type="button"
			aria-pressed={follow}
			onclick={() => (follow = !follow)}
			class={cn(
				'h-8 max-sm:min-h-11 rounded border px-2 text-xs',
				follow && 'bg-foreground text-background'
			)}>{follow ? 'Following' : 'Follow'}</button
		>
	</div>
	<div
		bind:this={port}
		bind:clientHeight={viewport}
		{onscroll}
		role="log"
		aria-live="off"
		class="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5"
	>
		<div class="relative" style:height="{total}px">
			<div class="absolute inset-x-0 top-0" style:transform="translateY({offs[win.start]}px)">
				{#each shown.slice(win.start, win.end) as row (row.id)}
					<div
						class="hover:bg-muted/50 grid h-[22px] grid-cols-[auto_3.5rem_minmax(0,1fr)] items-start gap-x-3 px-3 py-px"
						data-log-level={row.level}
					>
						<time
							class="text-muted-foreground whitespace-nowrap tabular-nums"
							datetime={new Date(row.at).toISOString()}>{time.format(new Date(row.at))}</time
						>
						<span class={cn('rounded px-1 text-center text-[10px] uppercase', BADGE[row.level])}
							>{row.level}</span
						>
						<code class="truncate whitespace-pre"
							>{#if row.source}<span class="text-muted-foreground"
									>{row.source}
								</span>{/if}{#each logPreview(row.message) as token, i (i)}<span
									class={token.cls || undefined}>{token.text}</span
								>{/each}</code
						>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
