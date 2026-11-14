<script lang="ts">
	// LogView's lines: the rows its toolbar leaves, virtualized, following the tail and loading older pages near the top.
	import { Effect } from 'effect';
	import type { LogViewProps } from './LogView.svelte';
	import { observe_once } from '../effect/index.js';
	import { tick } from 'svelte';
	import { watch } from 'runed';
	import Overflow from '../cell/Overflow.svelte';
	import { words_of } from '../client/context.js';
	import { cn, narrowViewport } from '../primitives/utils.js';
	import { offsets, windowOf } from '../primitives/virtual/virtual.js';
	import { ROW_HEIGHT, atBottom, logPreview, wantsOlder, type LogLevel } from './logs.js';

	let {
		ctx,
		rows: shown,
		load_older,
		has_older = false,
		follow = $bindable(true)
	}: Pick<LogViewProps, 'ctx' | 'rows' | 'load_older' | 'has_older' | 'follow'> = $props();
	let port = $state<HTMLDivElement>();
	let scrollTop = $state(0);
	let viewport = $state(0);
	let olderRequest = $state.raw<{
		load: NonNullable<LogViewProps['load_older']>;
		port: HTMLDivElement;
		before: number;
	} | null>(null);
	const olderPage = observe_once(() => {
		const request = olderRequest;
		return request === null || request.load !== load_older
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

	const offs = $derived(offsets(shown.map(() => ROW_HEIGHT)));
	const total = $derived(offs[offs.length - 1]);
	const win = $derived(windowOf(offs, scrollTop, viewport));
	const time = $derived(
		new Intl.DateTimeFormat(words_of(ctx).locale, {
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
		info: 'text-info',
		warn: 'bg-warning/15 text-warning-foreground dark:text-warning',
		error: 'bg-destructive/15 text-destructive'
	};

	const toBottom = () => port && (port.scrollTop = port.scrollHeight);
	watch([() => total, () => follow], () => {
		if (follow) toBottom();
	});

	function older() {
		if (port === undefined || load_older === undefined || loading) return;
		olderRequest = { load: load_older, port, before: total };
	}

	function onscroll() {
		if (!port) return;
		scrollTop = port.scrollTop;
		follow = atBottom(port);
		if (wantsOlder(scrollTop, has_older && !!load_older, loading)) void older();
	}
</script>

{#if loading}<span class="text-muted-foreground text-xs">Loading older…</span>{/if}
{#if notice}<span role="alert" class="text-destructive text-xs">{notice}</span>{/if}
<div
	bind:this={port}
	bind:clientHeight={viewport}
	{onscroll}
	role="log"
	aria-live="off"
	class="@container min-h-0 flex-1 overflow-auto rounded-md border bg-card font-mono text-xs leading-5"
	data-log-view
>
	<div class="relative" style:height="{total}px">
		<div class="absolute inset-x-0 top-0" style:transform="translateY({offs[win.start]}px)">
			{#each shown.slice(win.start, win.end) as row (row.id)}
				<!-- a row is 22px: a 44px floor on its expand button would cover the rows beside it -->
				<div
					class="hover:bg-muted/50 grid h-[22px] grid-cols-[auto_3.5rem_minmax(0,1fr)] items-start gap-x-3 px-3 py-px [--hit-target:0px] @max-md:grid-cols-[3.5rem_minmax(0,1fr)]"
					data-log-level={row.level}
				>
					<time
						class="text-muted-foreground whitespace-nowrap tabular-nums @max-md:hidden"
						datetime={new Date(row.at).toISOString()}>{time.format(new Date(row.at))}</time
					>
					<span class={cn('rounded px-1 text-center text-tiny uppercase', BADGE[row.level])}
						>{row.level}</span
					>
					<code class="min-w-0 [&_span]:whitespace-pre!"
						><Overflow text={row.message} expand={narrowViewport.current ? 'always' : 'never'}
							>{#if row.source}<span class="text-muted-foreground"
									>{row.source}
								</span>{/if}{#each logPreview(row.message) as token, i (i)}<span
									class={token.cls || undefined}>{token.text}</span
								>{/each}</Overflow
						></code
					>
				</div>
			{/each}
		</div>
	</div>
</div>
