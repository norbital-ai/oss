<!--
	Workspace Studio (§5.10) over the host's Studio port, in staging's layout: a title, the Workbench / Changes / Live
	segmented tabs, and under each a navigator rail (a bottom sheet on a phone) beside the main pane. Workbench is the
	source tree, a toolbar (the target, baseline, status and actions) and the editor over the last build's diagnosis; it
	edits source as drafts, saves them over the head it read, previews the build and publishes. Changes lists the viewer's
	draft and the merge requests (state, next owner and review age, L-BOLT-526) and reviews one: files before and after
	(L-BOLT-528), manifest, conversation and logs. Live lists the recorded commits and restores one; under it are the
	runtime log (`sys_event`, the one place the log is read) and Operations, the environments the host routes. Build log
	lines, a moved head, a moved merge request and phase frames (diagnose → preview → merge, L-BOLT-530) arrive pushed.
	Each tab is a deep link (`/studio/<tab>`: `mrs` opens Changes, `runtime` and `operations` open Live's views). Every
	staff member opens Studio over their own draft; publish, merge, review, restore, a preview on live data, the runtime log
	and someone else's merge request are an administrator's (`admin`), and the host refuses them regardless.
-->
<script lang="ts">
	import { Button, Icon, Sheet, Tabs } from '@norbital-ai/ui';
	import { Inline, INSET_X_CLASS, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { onMount, type Snippet } from 'svelte';
	import DiagnosisPane from './studio/DiagnosisPane.svelte';
	import LivePane from './studio/LivePane.svelte';
	import ReviewPane from './studio/ReviewPane.svelte';
	import SourceEditor from './studio/SourceEditor.svelte';
	import SourceTree from './studio/SourceTree.svelte';
	import WorkbenchToolbar from './studio/WorkbenchToolbar.svelte';
	import { foldLog, foldPhase, type PhaseState, reviewAge, reviewFreshness, reviewNextOwner, settleDrafts, type StudioFrame, type StudioMergeRequest,
		type StudioOp, type StudioPhase, type StudioView } from './studio.ts';
	import { based, SHELL, type StudioTab } from './nav.ts';
	import type { ShellApi } from './runtime.ts';

	// ponytail: `admin` defaults to true until the shell passes `boot.admin`; the host refuses a non-administrator's admin ops either way
	let { api, t, tab = 'workbench', onTab, admin = true }: { api: ShellApi; t: (key: string) => string; tab?: StudioTab; onTab?: (tab: StudioTab) => void; admin?: boolean } = $props();

	let view = $state<StudioView | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let file = $state('');
	let drafts = $state<{ [path: string]: string | null }>({});
	let showPreview = $state(false);
	// the URL's tab; a click shows it at once and asks the shell to move the URL (a back navigation moves it again)
	let active = $derived(tab);
	function go(next: StudioTab): void {
		active = next;
		onTab?.(next);
	}
	const root = $derived(active === 'changes' || active === 'mrs' ? 'changes' : active === 'live' || active === 'runtime' || active === 'operations' ? 'live' : 'workbench');
	let phases = $state<{ [p in StudioPhase]?: PhaseState }>({});
	let diff = $state(false);
	let selected = $state<string | null>(null);
	let releaseAt = $state<string | null>(null);
	let browsing = $state(false);

	async function load(): Promise<void> {
		const r = await api.studio();
		if (r.ok) view = r.value;
		else error = r.error.message;
	}
	void load();
	onMount(() => {
		if (typeof EventSource === 'undefined') return;
		const events = new EventSource(based(`${SHELL}/studio/events`), { withCredentials: true });
		events.onmessage = (e: MessageEvent<string>) => {
			const frame = JSON.parse(e.data) as StudioFrame;
			if (view === null) return;
			if (frame.kind === 'log') view.log = foldLog(view.log, frame.line);
			// another editor saved: reload the source; drafts stay (a save over the old head is refused, not lost)
			else if (frame.kind === 'source' && frame.commit !== view.commit && !busy) void load();
			// a merge request moved (a comment, a decision, a merge, a preview): reload unless our own op is in flight
			else if (frame.kind === 'mr' && !busy) void load();
			else if (frame.kind === 'phase') phases = foldPhase(phases, frame.phase, frame.state);
		};
		return () => events.close();
	});
	async function run(op: StudioOp): Promise<boolean> {
		busy = true;
		error = null;
		const r = await api.studioRun(op);
		busy = false;
		if (!r.ok) return (error = r.error.message), false;
		view = r.value;
		return true;
	}
	async function save(): Promise<boolean> {
		if (view === null || Object.keys(drafts).length === 0) return true;
		const saved = $state.snapshot(drafts);
		const ok = await run({ op: 'save', expected: view.commit, files: saved });
		// an edit made while the save was in flight is newer than what was saved: it stays a draft
		if (ok) drafts = settleDrafts(drafts, saved);
		return ok;
	}
	async function publish(): Promise<void> {
		if (await save()) await run({ op: 'publish' });
	}
	async function restore(commit: string): Promise<void> {
		if (confirm(t('Restore live to this commit? The workbench keeps its source.'))) await run({ op: 'restore', commit });
	}
	function edit(value: string): void {
		if (view?.files[file] === value) delete drafts[file];
		else drafts[file] = value;
	}
	async function openMr(): Promise<void> {
		const title = prompt(t('Merge request title'))?.trim();
		if (title && (await save())) await run({ op: 'mr.open', title });
	}
	async function switchTo(target: string): Promise<void> {
		if (Object.keys(drafts).length > 0 && !confirm(t('Discard unsaved drafts and switch?'))) return;
		drafts = {};
		if (await run({ op: 'switch', target })) go('workbench');
	}
	function create(): void {
		const path = prompt(t('New file path'))?.trim();
		if (!path) return;
		drafts[path] = drafts[path] ?? view?.files[path] ?? '';
		file = path;
	}
	function openFile(path: string): void {
		file = path;
		showPreview = false;
		browsing = false;
		go('workbench');
	}
	function togglePreview(): void {
		showPreview = !showPreview;
		if (showPreview && view?.preview === null) void run({ op: 'preview' });
	}
	const files = $derived(view === null ? [] : [...new Set([...Object.keys(view.files), ...Object.keys(drafts)])].sort());
	const source = $derived(drafts[file] ?? view?.files[file] ?? '');
	const target = $derived(view?.target ?? 'workbench');
	const mrs = $derived(view?.mergeRequests ?? []);
	/** A merge request the viewer may switch to and tend: any for an administrator, else one over their own branch. */
	const mine = (m: StudioMergeRequest) => admin || (m.branch !== undefined && m.branch === view?.branch);
	const open = $derived(mrs.filter((m) => (m.state === 'draft' || m.state === 'ready') && mine(m)));
	const current = $derived(mrs.find((m) => m.id === selected) ?? null);
	const releases = $derived(view?.releases ?? []);
	const release = $derived(releases.find((r) => r.commit === releaseAt) ?? releases.find((r) => r.current) ?? releases[0]);
	const draftCount = $derived(Object.keys(drafts).length);
	const short = (commit: string) => commit.slice(0, 8);
	const FRESH = { current: 'Current', live_advanced: 'Live moved on', terminal: 'Closed' } as const;
	const OWNER = { author: 'Author', reviewer: 'Reviewer', complete: 'Done' } as const;
	const ROW = 'w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/70 aria-[current=true]:bg-primary/5';
</script>

<!-- the navigator rail beside the pane (a bottom sheet on a phone) and the pane -->
{#snippet frame(navigator: Snippet, main: Snippet, top?: Snippet)}
	<Stack gap="none" fill class="min-h-0 {INSET_X_CLASS}">
		{@render top?.()}
		<Inline align="stretch" gap="none" grow class="min-h-0 min-w-0">
			<aside class="hidden w-72 shrink-0 border-r border-border/60 bg-card md:block" aria-label={t('Workspace navigator')}>
				<Stack gap="none" fill class="min-h-0">{@render navigator()}</Stack>
			</aside>
			<div class="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">{@render main()}</div>
		</Inline>
	</Stack>
{/snippet}

{#snippet railHeading(icon: string, label: string)}
	<Inline gap="xs" shrink={false} class="border-b border-border/60 px-3 py-1.5">
		<Icon name={icon} class="size-3.5 text-muted-foreground" /><span class="text-overline text-foreground">{label}</span>
	</Inline>
{/snippet}

{#snippet sourceNav()}
	{#if view !== null}
		<SourceTree {files} base={view.files} {drafts} selected={file} onselect={openFile} {t} />
	{/if}
{/snippet}

{#snippet changesNav()}
	{@render railHeading('lucide:git-pull-request', t('Changes'))}
	<Scroll name={t('Changes')} layout="stack" gap="xs" grow class="min-h-0 p-2">
		<button type="button" class={ROW} aria-current={selected === null} onclick={() => { selected = null; browsing = false; }}>
			<span class="block truncate text-xs font-medium text-foreground">{t('My draft')}</span>
			<span class="block truncate font-mono text-micro text-muted-foreground">{#if view?.branch !== undefined}{view.branch} · {/if}{short(view?.commit ?? '')}</span>
			<span class="mt-1 block truncate text-micro text-muted-foreground">{view?.changes.length ?? 0} {t('changed files')}{#if (view?.behind ?? 0) > 0} · {view?.behind} {t('behind live')}{/if}</span>
		</button>
		{#if view?.mergeRequests !== undefined}
			<p class="px-2 pt-2 text-overline">{t('Merge requests')}</p>
			{#each [...mrs].reverse() as m (m.id)}
				<button type="button" class={ROW} data-state={m.state} aria-current={m.id === selected} onclick={() => { selected = m.id; browsing = false; }}>
					<span class="block truncate text-xs font-medium text-foreground">!{m.id} {m.title}</span>
					<span class="block truncate font-mono text-micro text-muted-foreground">{m.openedBy} · {short(m.head)}…{short(m.base)}</span>
					<span class="mt-1 block truncate text-micro text-muted-foreground">{t(FRESH[reviewFreshness(m)])} · {t('next')}: {t(OWNER[reviewNextOwner(m)])}{#if m.readyAt !== null && reviewFreshness(m) !== 'terminal'} · {t('in review')} {reviewAge(m.readyAt, Date.now())}{/if}</span>
				</button>
			{:else}
				<p class="px-2 py-2 text-micro text-muted-foreground">{t('No merge requests.')}</p>
			{/each}
		{/if}
	</Scroll>
{/snippet}

{#snippet liveNav()}
	{@render railHeading('lucide:history', t('Live'))}
	<Scroll name={t('Live')} layout="stack" gap="xs" grow class="min-h-0 p-2">
		{#each releases as r (r.commit)}
			<button type="button" class={ROW} aria-current={r.commit === release?.commit} onclick={() => { releaseAt = r.commit; browsing = false; }}>
				<span class="block truncate font-mono text-xs font-medium text-foreground">{r.commit.slice(0, 12)}</span>
				{#if r.current}<span class="mt-1 block text-micro text-muted-foreground">{t('Serving now')}</span>{/if}
				<span class="block truncate text-micro text-foreground">{r.message}</span>
				<span class="block text-micro text-muted-foreground"><time datetime={r.at}>{new Date(r.at).toLocaleString()}</time></span>
				{#if r.checkpoint}<span class="block text-micro text-muted-foreground">{t('checkpoint')} <time datetime={r.checkpoint}>{new Date(r.checkpoint).toLocaleString()}</time></span>{/if}
			</button>
		{:else}
			<p class="px-1 py-2 text-micro text-muted-foreground">{t('No recorded commits.')}</p>
		{/each}
	</Scroll>
{/snippet}

{#snippet toolbar()}
	{#if view !== null}
		<WorkbenchToolbar {view} targets={open} {admin} {busy} drafts={draftCount} {phases} {error} previewing={showPreview} {t}
			onswitch={(x) => void switchTo(x)} onnew={create} onsave={() => void save()} onpreview={togglePreview} onrebase={() => void run({ op: 'rebase' })}
			onopenmr={() => void openMr()} onpublish={() => void publish()} onreview={() => { selected = target; go('changes'); }} />
		{#if (view.conflicts?.length ?? 0) > 0}
			<Inline gap="xs" shrink={false} role="alert" class="border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
				<Icon name="lucide:triangle-alert" class="size-3 shrink-0" /><span class="truncate text-xs">{t('Resolve the conflict markers in')} {view.conflicts?.join(', ')}</span>
			</Inline>
		{/if}
	{/if}
{/snippet}

{#snippet workbenchMain()}
	{#if view !== null}
		{#if showPreview}
			{@const p = view.previewOf}
			<Stack gap="none" fill class="min-h-0">
				<Inline gap="xs" shrink={false} class="flex-wrap border-b border-border/60 px-3 py-1.5 text-micro">
					{#if target === 'workbench'}
						<Button size="sm" variant="outline" class="h-7 px-2 text-micro" disabled={busy} onclick={() => void run({ op: 'preview' })}>
							<Icon name="lucide:refresh-cw" class="size-3.5" />{t(view.preview === null ? 'Preview on sample data' : 'Rebuild preview')}
						</Button>
						{#if admin}<Button size="sm" variant="ghost" class="h-7 px-2 text-micro" disabled={busy} onclick={() => void run({ op: 'preview', live: true })}>{t('Preview on live data')}</Button>{/if}
						{#if view.preview !== null}<Button size="sm" variant="ghost" class="h-7 px-2 text-micro" disabled={busy} onclick={() => void run({ op: 'exit' })}>{t('Exit preview')}</Button>{/if}
					{/if}
					{#if p !== undefined}
						<span class="text-muted-foreground">{t(p.live ? 'on live data' : 'on sample data')} · <code class="font-mono">{short(p.artifact)}</code>
							{#if p.stale} · <span class="text-amber-700 dark:text-amber-300">{t('stale: built from')} <code class="font-mono">{short(p.commit)}</code></span>{/if}
							· {t('expires')} {new Date(p.expiresAt).toLocaleString()}</span>
					{/if}
				</Inline>
				{#if view.preview === null}
					<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
						<Icon name={busy ? 'lucide:loader-2' : 'lucide:scan-eye'} class="size-8 opacity-30 {busy ? 'animate-spin' : ''}" />
						<p class="text-xs">{busy ? t('Building the preview…') : t('No preview yet.')}</p>
					</Stack>
				{:else}
					<iframe title={t('Workbench preview')} src={view.preview} class="min-h-0 w-full flex-1 border-0 bg-background"></iframe>
				{/if}
			</Stack>
		{:else}
			<Stack gap="none" fill class="min-h-0">
				<div class="min-h-0 flex-1">
					<SourceEditor path={file} value={source ?? ''} baseline={view.baseline?.[file]} {diff} deleted={drafts[file] === null} fileCount={files.length}
						against={t(target === 'workbench' ? 'against Live' : 'against MR head')} onChange={edit} onDiff={() => (diff = !diff)} onDelete={() => (drafts[file] = null)} {t} />
				</div>
				<DiagnosisPane diagnostics={view.diagnostics} stale={draftCount > 0} {busy} onopen={openFile} onrerun={() => void run({ op: 'preview' })} {t} />
			</Stack>
		{/if}
	{/if}
{/snippet}

{#snippet changesMain()}
	{#if view !== null}
		{#key current?.id ?? ''}
			<ReviewPane {view} request={current} {admin} {busy} {mine} onopen={(p) => { openFile(p); diff = true; }} onswitch={(x) => void switchTo(x)} onopenmr={() => void openMr()} {run} {t} />
		{/key}
	{/if}
{/snippet}

{#snippet liveMain()}
	{#if view !== null}
		<LivePane {api} {view} {release} {admin} {busy} sub={active === 'operations' ? 'operations' : 'runtime'} onsub={go} onrestore={(c) => void restore(c)} {t} />
	{/if}
{/snippet}

{#snippet workbenchTab()}{@render frame(sourceNav, workbenchMain, toolbar)}{/snippet}
{#snippet changesTab()}{@render frame(changesNav, changesMain)}{/snippet}
{#snippet liveTab()}{@render frame(liveNav, liveMain)}{/snippet}

{#snippet browse()}
	<Button variant="ghost" size="sm" class="shrink-0 md:hidden" aria-label={t('Open the navigator')} onclick={() => (browsing = true)}>
		<Icon name="lucide:panel-bottom" class="size-4" />{t('Browse')}
	</Button>
{/snippet}

<Stack gap="none" grow class="min-h-0 bg-background">
	<Stack as="header" gap="xs" shrink={false} class="px-4 pt-3 sm:px-6 sm:pt-6">
		<h1 class="text-heading">{t('Workspace Studio')}</h1>
		<p class="hidden max-w-2xl text-meta sm:block">{t('Edit safely, preview the exact result, then ask for review.')}</p>
	</Stack>
	{#if view === null}
		<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
			{#if error === null}<Icon name="lucide:loader-2" class="size-6 animate-spin opacity-40" /><p class="text-xs">{t('Loading…')}</p>
			{:else}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		</Stack>
	{:else}
		{#if error !== null && root !== 'workbench'}
			<p role="alert" class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-6">{error}</p>
		{/if}
		<Tabs value={root} onValueChange={(v) => go(v === 'changes' ? 'changes' : v === 'live' ? 'live' : 'workbench')} trailing={browse}
			class="mt-4 min-h-0 flex-1 gap-3 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6"
			tabs={[{ name: 'workbench', title: t('Workbench'), body: workbenchTab, keepAlive: true as const },
				{ name: 'changes', title: t('Changes'), body: changesTab }, { name: 'live', title: t('Live'), body: liveTab }]} />
	{/if}
</Stack>

{#if view !== null}
	<Sheet bind:open={browsing} title={t('Workspace navigator')}>
		<Stack gap="none" fill class="min-h-0">
			{#if root === 'workbench'}{@render sourceNav()}{:else if root === 'changes'}{@render changesNav()}{:else}{@render liveNav()}{/if}
		</Stack>
	</Sheet>
{/if}
