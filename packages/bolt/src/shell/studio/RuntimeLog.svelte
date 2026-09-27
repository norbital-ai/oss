<!--
	The workspace's runtime log (§5.12, `sys_event`) in Studio — the one place the log is read. A toolbar narrows it by level
	and text and follows the tail; each line is its time, level, source (the event) and a summary, and opens to its detail
	(run, conversation, turn, invocation and attributes). Older pages load by cursor; the tail is read every two seconds
	while following, and scrolling up stops following.
-->
<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { Button, Icon } from '@norbital-ai/ui';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { LogLevel, LogRow } from '../data.ts';
	import type { ShellApi } from '../runtime.ts';

	let { api, t }: { api: ShellApi; t: (key: string) => string } = $props();

	const PAGE = 200;
	const LEVELS = ['info', 'warn', 'error'] as const;
	let lines = $state<LogRow[]>([]);
	let level = $state<LogLevel | undefined>();
	let text = $state('');
	let follow = $state(true);
	let older = $state(true);
	let loaded = $state(false);
	let error = $state<string | null>(null);
	let open = $state<{ [id: string]: true }>({});
	let port = $state<HTMLElement | null>(null);
	let busy = false;
	let generation = 0;

	async function page(cursor: { before?: string; after?: string }): Promise<LogRow[] | null> {
		const asked = generation;
		busy = true;
		const r = await api.logs({ ...cursor, ...(level === undefined ? {} : { level }), ...(text.trim() === '' ? {} : { text: text.trim() }) });
		busy = false;
		if (asked !== generation) return null; // the filter moved while this page was in flight
		if (!r.ok) return (error = r.error.message), null;
		error = null;
		loaded = true;
		return r.value.reverse();
	}
	async function loadOlder(): Promise<void> {
		if (busy || !older) return;
		const before = lines[0]?.id;
		const rows = await page(before === undefined ? {} : { before });
		if (rows === null) return;
		older = rows.length === PAGE;
		lines = [...rows, ...lines];
		if (before === undefined) await bottom();
	}
	async function tail(): Promise<void> {
		if (busy || !follow) return;
		const after = lines.at(-1)?.id;
		if (after === undefined) return loadOlder();
		const rows = await page({ after });
		if (rows !== null && rows.length > 0) {
			lines = [...lines, ...rows];
			await bottom();
		}
	}
	async function bottom(): Promise<void> {
		await tick();
		if (follow && port !== null) port.scrollTop = port.scrollHeight;
	}
	/** A new filter starts over from the newest page. */
	function refilter(): void {
		generation++;
		busy = false;
		lines = [];
		older = true;
		loaded = false;
		open = {};
		void loadOlder();
	}
	let typing: ReturnType<typeof setTimeout> | undefined;
	void loadOlder();
	const timer = setInterval(() => void tail(), 2_000);
	onDestroy(() => { clearInterval(timer); clearTimeout(typing); });

	const clock = (at: string) => {
		const d = new Date(at);
		return Number.isNaN(d.getTime()) ? at : `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
	};
	const summary = (r: LogRow) => {
		const a = r.attributes === null || typeof r.attributes !== 'object' || Array.isArray(r.attributes) ? ''
			: Object.entries(r.attributes).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
		return [r.run === null ? '' : `run=${r.run}`, r.conversation === null ? '' : `conversation=${r.conversation}`, a].filter((x) => x !== '').join(' ');
	};
	const detail = (r: LogRow) => JSON.stringify({ at: r.at, invocation: r.invocation, run: r.run, conversation: r.conversation, turn: r.turn, attributes: r.attributes }, null, 2);
	const TONE: { readonly [l in LogLevel]: string } = { info: 'text-muted-foreground', warn: 'text-amber-800 dark:text-amber-300', error: 'text-destructive' };
	const CHIP = 'h-6 rounded-full border px-2.5 text-micro font-medium transition-colors aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background text-muted-foreground hover:text-foreground';
</script>

<Stack gap="none" fill class="min-h-0">
	<Inline gap="xs" shrink={false} class="flex-wrap border-b border-border/60 px-4 py-2 sm:px-6">
		<Inline gap="xs" role="group" aria-label={t('Level')}>
			<button type="button" class={CHIP} aria-pressed={level === undefined} onclick={() => { level = undefined; refilter(); }}>{t('All')}</button>
			{#each LEVELS as l (l)}
				<button type="button" class={CHIP} aria-pressed={level === l} onclick={() => { level = l; refilter(); }}>{t(l === 'info' ? 'Info' : l === 'warn' ? 'Warning' : 'Error')}</button>
			{/each}
		</Inline>
		<label class="relative min-w-40 flex-1">
			<Icon name="lucide:search" class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<input type="search" bind:value={text} aria-label={t('Filter the log')} placeholder={t('Filter by event or attribute')}
				oninput={() => { clearTimeout(typing); typing = setTimeout(refilter, 300); }}
				class="block h-7 w-full min-w-0 rounded-sm border border-border/60 bg-background py-0 pr-2 pl-7 text-xs text-foreground placeholder:text-muted-foreground" />
		</label>
		<Button size="sm" variant={follow ? 'secondary' : 'ghost'} class="h-7 px-2 text-micro" aria-pressed={follow}
			onclick={() => { follow = !follow; if (follow) { void tail(); void bottom(); } }}>
			<Icon name={follow ? 'lucide:radio' : 'lucide:pause'} class="size-3.5 {follow ? 'text-success' : ''}" />{t(follow ? 'Following' : 'Follow')}
		</Button>
	</Inline>
	{#if error !== null}<p role="alert" class="shrink-0 bg-destructive/10 px-4 py-2 text-xs text-destructive sm:px-6">{error}</p>{/if}
	<Scroll name={t('Runtime log')} grow bind:ref={port} class="min-h-0"
		onscroll={() => { if (port !== null) follow = port.scrollHeight - port.scrollTop - port.clientHeight < 24; }}>
		{#if lines.length === 0}
			<Stack gap="sm" align="center" justify="center" class="h-full py-12 text-center text-muted-foreground">
				<Icon name="lucide:scroll-text" class="size-8 opacity-30" />
				<p class="text-xs">{loaded || error !== null ? t('No runtime records.') : t('Loading…')}</p>
			</Stack>
		{:else}
			<div role="log" aria-live="off" class="px-2 py-2 font-mono text-xs leading-5 sm:px-4">
				{#if older}
					<button type="button" class="mb-1 w-full rounded-md py-1 text-center text-micro text-muted-foreground hover:bg-muted/50" onclick={() => void loadOlder()}>{t('Load older')}</button>
				{/if}
				{#each lines as r (r.id)}
					<div class="rounded-md hover:bg-muted/40 {open[r.id] ? 'bg-muted/40' : ''}">
						<button type="button" class="grid w-full grid-cols-[auto_3.25rem_minmax(0,1fr)] items-baseline gap-x-2 px-2 text-left sm:grid-cols-[auto_3.25rem_minmax(8rem,14rem)_minmax(0,1fr)]"
							aria-expanded={open[r.id] === true} onclick={() => (open[r.id] ? delete open[r.id] : (open[r.id] = true))}>
							<time datetime={r.at} title={r.at} class="text-muted-foreground tabular-nums">{clock(r.at)}</time>
							<span class="uppercase {TONE[r.severity]}">{r.severity}</span>
							<span class="truncate text-foreground" title={r.event}>{r.event}</span>
							<span class="col-span-3 truncate text-muted-foreground sm:col-span-1">{summary(r)}</span>
						</button>
						{#if open[r.id]}
							<pre class="mx-2 mb-1 overflow-x-auto rounded-md bg-background p-2 whitespace-pre-wrap break-all text-foreground">{detail(r)}</pre>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</Scroll>
</Stack>
