<!--
	The workspace's runtime log (§5.12, held by the host's log store) in Studio. A toolbar narrows it by level
	and text and follows the tail; `since` / `until` scope it to a window (a deployment's live span), and a run id to one run's
	events; each line is its time, level, source (the event) and a summary, and opens to its detail
	(run, conversation, turn, invocation and attributes). Older pages load by cursor; the tail is read every two seconds
	while following, and scrolling up stops following.
-->
<script lang="ts">
	import { attach, fork, query } from '@norbital-ai/ui/effect';
	import { Deferred, Effect, Schedule, Semaphore } from 'effect';
	import { tick } from 'svelte';
	import { watch } from 'runed';
	import { Button, Icon } from '@norbital-ai/ui';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { LogLevel, LogRow } from '../../engine/contracts.ts';
	import type { ShellApi } from '../api-types.ts';

	let {
		api,
		t,
		since,
		until
	}: {
		api: ShellApi;
		t: (key: string) => string;
		since?: string | undefined;
		until?: string | undefined;
	} = $props();

	const PAGE = 200;
	const LEVELS = ['info', 'warn', 'error'] as const;
	let level = $state<LogLevel | undefined>();
	let text = $state('');
	let run = $state('');
	let follow = $state(true);
	let open = $state<{ [id: string]: true }>({});
	let port = $state<HTMLElement | null>(null);
	const filter = $derived({ api, level, text: text.trim(), run: run.trim(), since, until });
	type Request = {
		filter: typeof filter;
		cursor: { before?: string; after?: string };
		append: 'initial' | 'older' | 'tail';
		done?: Deferred.Deferred<void>;
	};
	let request = $state.raw<Request | undefined>();
	let window = $state.raw<{ filter: typeof filter; rows: LogRow[]; older: boolean } | undefined>();
	const lines = $derived(window?.filter === filter ? window.rows : []);
	const older = $derived(window?.filter === filter ? window.older : true);
	const loaded = $derived(window?.filter === filter);
	const asked: Request = $derived(
		request?.filter === filter ? request : { filter, cursor: {}, append: 'initial' }
	);
	const bottom = Effect.tryPromise(tick).pipe(
		// A failed Svelte render is a UI defect, reported by the mounted edge.
		Effect.orDie,
		Effect.tap(() =>
			Effect.sync(() => {
				if (follow && port !== null) port.scrollTop = port.scrollHeight;
			})
		)
	);
	const page = query(() => {
		const own = asked;
		const obsolete = request?.filter !== own.filter ? request?.done : undefined;
		return (obsolete === undefined ? Effect.void : Deferred.succeed(obsolete, undefined)).pipe(
			Effect.andThen(
				own.filter.api.logs({
					...own.cursor,
					...(own.filter.level === undefined ? {} : { level: own.filter.level }),
					...(own.filter.text === '' ? {} : { text: own.filter.text }),
					...(own.filter.run === '' ? {} : { run: own.filter.run }),
					...(own.filter.since === undefined ? {} : { since: own.filter.since }),
					...(own.filter.until === undefined ? {} : { until: own.filter.until })
				})
			),
			Effect.delay(own.append === 'initial' ? '300 millis' : 0),
			Effect.tap((answer) =>
				Effect.sync(() => {
					const rows = [...answer].reverse();
					const previous = window?.filter === own.filter ? window : undefined;
					window = {
						filter: own.filter,
						rows:
							own.append === 'tail'
								? [...(previous?.rows ?? []), ...rows]
								: [...rows, ...(previous?.rows ?? [])],
						older: own.append === 'tail' ? (previous?.older ?? true) : rows.length === PAGE
					};
				})
			),
			Effect.tap((rows) => (own.append !== 'older' && rows.length > 0 ? bottom : Effect.void)),
			Effect.onExit(() =>
				own.done === undefined ? Effect.void : Deferred.succeed(own.done, undefined)
			)
		);
	});
	const reads = Semaphore.makeUnsafe(1);
	const read = (cursor: Request['cursor'], append: Request['append']) =>
		Effect.gen(function* () {
			const done = yield* Deferred.make<void>();
			request = { filter, cursor, append, done };
			yield* Deferred.await(done);
		});
	const loadOlder = () =>
		reads
			.withPermitsIfAvailable(1)(
				Effect.gen(function* () {
					if (page.loading || !older) return;
					const before = lines[0]?.id;
					yield* read(
						before === undefined ? {} : { before },
						before === undefined ? 'initial' : 'older'
					);
				})
			)
			.pipe(Effect.asVoid);
	const tail = reads
		.withPermitsIfAvailable(1)(
			Effect.gen(function* () {
				if (page.loading || !follow) return;
				const after = lines.at(-1)?.id;
				yield* read(after === undefined ? {} : { after }, after === undefined ? 'initial' : 'tail');
			})
		)
		.pipe(Effect.asVoid);
	watch(
		() => filter,
		() => {
			open = {};
		}
	);
	const observe = attach(() =>
		tail.pipe(
			Effect.repeat(Schedule.spaced('2 seconds')),
			Effect.delay('2 seconds'),
			Effect.onExit(() =>
				request?.done === undefined ? Effect.void : Deferred.succeed(request.done, undefined)
			)
		)
	);

	const clock = (at: string) => {
		const d = new Date(at);
		return Number.isNaN(d.getTime())
			? at
			: `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
	};
	const summary = (r: LogRow) => {
		const a =
			r.attributes === null || typeof r.attributes !== 'object' || Array.isArray(r.attributes)
				? ''
				: Object.entries(r.attributes)
						.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
						.join(' ');
		return [
			r.run === null ? '' : `run=${r.run}`,
			r.conversation === null ? '' : `conversation=${r.conversation}`,
			a
		]
			.filter((x) => x !== '')
			.join(' ');
	};
	const detail = (r: LogRow) =>
		JSON.stringify(
			{
				at: r.at,
				invocation: r.invocation,
				run: r.run,
				conversation: r.conversation,
				turn: r.turn,
				attributes: r.attributes
			},
			null,
			2
		);
	const TONE: { readonly [l in LogLevel]: string } = {
		info: 'text-muted-foreground',
		warn: 'text-amber-800 dark:text-amber-300',
		error: 'text-destructive'
	};
	const CHIP =
		'h-8 rounded-full border px-2.5 text-micro font-medium transition-colors aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background text-muted-foreground hover:text-foreground';
</script>

<span hidden {@attach observe}></span>

<Stack gap="none" fill class="min-h-0">
	<Inline gap="xs" shrink={false} class="flex-wrap border-b border-border/60 px-4 py-2 sm:px-6">
		<Inline gap="xs" role="group" aria-label={t('Level')}>
			<button
				type="button"
				class={CHIP}
				aria-pressed={level === undefined}
				onclick={() => {
					level = undefined;
				}}>{t('All')}</button
			>
			{#each LEVELS as l (l)}
				<button
					type="button"
					class={CHIP}
					aria-pressed={level === l}
					onclick={() => {
						level = l;
					}}>{t(l === 'info' ? 'Info' : l === 'warn' ? 'Warning' : 'Error')}</button
				>
			{/each}
		</Inline>
		<label class="relative min-w-40 flex-1">
			<Icon
				name="lucide:search"
				class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="search"
				bind:value={text}
				aria-label={t('Filter the log')}
				placeholder={t('Filter by event or attribute')}
				class="block h-8 w-full min-w-0 rounded-sm border border-border/60 bg-background py-0 pr-2 pl-7 text-xs text-foreground placeholder:text-muted-foreground"
			/>
		</label>
		<input
			type="search"
			bind:value={run}
			aria-label={t('Filter by run')}
			placeholder={t('Run id')}
			class="block h-8 w-36 min-w-0 rounded-sm border border-border/60 bg-background px-2 py-0 font-mono text-xs text-foreground placeholder:text-muted-foreground"
		/>
		<Button
			size="sm"
			variant={follow ? 'secondary' : 'ghost'}
			class="px-2 text-micro"
			aria-pressed={follow}
			onclick={() => {
				follow = !follow;
				if (follow) {
					fork(tail.pipe(Effect.andThen(bottom)));
				}
			}}
		>
			<Icon
				name={follow ? 'lucide:radio' : 'lucide:pause'}
				class="size-3.5 {follow ? 'text-success' : ''}"
			/>{t(follow ? 'Following' : 'Follow')}
		</Button>
	</Inline>
	{#if page.error !== undefined}<p
			role="alert"
			class="shrink-0 bg-destructive/10 px-4 py-2 text-xs text-destructive sm:px-6"
		>
			{page.error.message}
		</p>{/if}
	<Scroll
		name={t('Runtime log')}
		grow
		bind:ref={port}
		class="min-h-0"
		onscroll={() => {
			if (port !== null) follow = port.scrollHeight - port.scrollTop - port.clientHeight < 24;
		}}
	>
		{#if lines.length === 0}
			<Stack
				gap="sm"
				align="center"
				justify="center"
				class="h-full py-12 text-center text-muted-foreground"
			>
				<Icon name="lucide:scroll-text" class="size-8 opacity-30" />
				<p class="text-xs">
					{loaded || page.error !== undefined ? t('No runtime records.') : t('Loading…')}
				</p>
			</Stack>
		{:else}
			<div role="log" aria-live="off" class="px-2 py-2 font-mono text-xs leading-5 sm:px-4">
				{#if older}
					<button
						type="button"
						class="mb-1 w-full rounded-md py-1 text-center text-micro text-muted-foreground hover:bg-muted/50"
						onclick={() => fork(loadOlder())}>{t('Load older')}</button
					>
				{/if}
				{#each lines as r (r.id)}
					<div class="rounded-md hover:bg-muted/40 {open[r.id] ? 'bg-muted/40' : ''}">
						<button
							type="button"
							class="grid w-full grid-cols-[auto_3.25rem_minmax(0,1fr)] items-baseline gap-x-2 px-2 text-left sm:grid-cols-[auto_3.25rem_minmax(8rem,14rem)_minmax(0,1fr)]"
							aria-expanded={open[r.id] === true}
							onclick={() => (open[r.id] ? delete open[r.id] : (open[r.id] = true))}
						>
							<time datetime={r.at} title={r.at} class="text-muted-foreground tabular-nums"
								>{clock(r.at)}</time
							>
							<span class="uppercase {TONE[r.severity]}">{r.severity}</span>
							<span class="truncate text-foreground" title={r.event}>{r.event}</span>
							<span class="col-span-3 truncate text-muted-foreground sm:col-span-1"
								>{summary(r)}</span
							>
						</button>
						{#if open[r.id]}
							<pre
								class="mx-2 mb-1 overflow-x-auto rounded-md bg-background p-2 whitespace-pre-wrap break-all text-foreground">{detail(
									r
								)}</pre>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</Scroll>
</Stack>
