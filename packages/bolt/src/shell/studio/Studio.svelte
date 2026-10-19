<!--
	Workspace Studio (§5.10) over the host's Studio port: a title, the Workbench / Changes / Live
	segmented tabs, and under each a navigator rail (a bottom sheet on a phone) beside the main pane. Workbench is the
	source tree, a toolbar (the target, baseline, status and actions) and the editor over the last build's diagnosis; it
	edits source as drafts, saves them over the head it read, previews the build and publishes. Changes lists the viewer's
	draft and the merge requests (state, next owner and review age, L-BOLT-526) and reviews one: files before and after
	(L-BOLT-528), manifest, conversation and logs. Live lists the deployments (a rollback is one too) and rolls live back
	to one: its build deployed again as a new deployment, keeping the data unless its schema differs (the confirm then
	names what is lost). That is a source rollback, neither the operator's database restore nor a record's restore. Each
	build's stored log and diagnostics open from the rail. Under it are the runtime log (`sys_event`, the one place the log is read) and Operations, the environments the host routes. Build log
	lines, a moved head, a moved merge request and phase frames (diagnose → preview → merge, L-BOLT-530) arrive pushed.
	Each tab is a deep link (`/studio/<tab>`: `mrs` opens Changes, `runtime` and `operations` open Live's views). Every
	staff member opens Studio over their own draft; publish, merge, review, rollback, a preview on live data, the runtime log
	and someone else's merge request are an administrator's (`admin`), and the host refuses them regardless.
-->
<script lang="ts">
	import { attach, fork } from '@norbital-ai/ui/effect';
	import { Cause, Effect, Queue, Schema, Stream } from 'effect';
	import { Button, Icon, Sheet, Tabs } from '@norbital-ai/ui';
	import { Inline, INSET_X_CLASS, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { Snippet } from 'svelte';
	import BuildLog from './BuildLog.svelte';
	import DiagnosisPane from './DiagnosisPane.svelte';
	import LivePane from './LivePane.svelte';
	import ReviewPane from './ReviewPane.svelte';
	import SourceEditor from './SourceEditor.svelte';
	import SourceTree from './SourceTree.svelte';
	import WorkbenchToolbar from './WorkbenchToolbar.svelte';
	import {
		foldLog,
		foldPhase,
		type PhaseState,
		reviewAge,
		reviewFreshness,
		reviewNextOwner,
		settleDrafts,
		type StudioBuildRecord,
		type StudioFrame,
		type StudioMergeRequest,
		type StudioOp,
		type StudioPhase,
		type StudioView
	} from './model.ts';
	import { based, SHELL, type StudioTab } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';

	// ponytail: `admin` defaults to true until the shell passes `boot.admin`; the host refuses a non-administrator's admin ops either way
	let {
		api,
		t,
		tab = 'workbench',
		onTab,
		admin = true
	}: {
		api: ShellApi;
		t: (key: string) => string;
		tab?: StudioTab;
		onTab?: (tab: StudioTab) => void;
		admin?: boolean;
	} = $props();

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
	const root = $derived(
		active === 'changes' || active === 'mrs'
			? 'changes'
			: active === 'live' || active === 'runtime' || active === 'operations'
				? 'live'
				: 'workbench'
	);
	let phases = $state<{ [p in StudioPhase]?: PhaseState }>({});
	let diff = $state(false);
	let selected = $state<string | null>(null);
	let releaseAt = $state<string | null>(null);
	let browsing = $state(false);

	const load = () =>
		api.studio().pipe(
			Effect.tap((next) =>
				Effect.sync(() => {
					view = { ...next };
				})
			),
			Effect.catch((cause) =>
				Effect.sync(() => {
					error = cause.message;
				})
			)
		);
	class StudioStreamFailed extends Schema.TaggedError<StudioStreamFailed>()('StudioStreamFailed', {
		message: Schema.String
	}) {}
	const FrameSchema = Schema.Union([
		Schema.Struct({
			kind: Schema.Literal('log'),
			line: Schema.Struct({
				at: Schema.String,
				level: Schema.Literals(['info', 'warn', 'error']),
				message: Schema.String
			})
		}),
		Schema.Struct({ kind: Schema.Literal('source'), commit: Schema.String }),
		Schema.Struct({ kind: Schema.Literal('mr'), id: Schema.String }),
		Schema.Struct({
			kind: Schema.Literal('phase'),
			phase: Schema.Literals(['diagnose', 'preview', 'merge']),
			state: Schema.Literals(['running', 'done', 'failed'])
		})
	]);
	const events = Stream.callback<StudioFrame, StudioStreamFailed>((queue) =>
		Effect.acquireRelease(
			Effect.try({
				try: () => new EventSource(based(`${SHELL}/studio/events`), { withCredentials: true }),
				catch: () => new StudioStreamFailed({ message: 'Studio events could not be opened.' })
			}),
			(source) => Effect.sync(() => source.close())
		).pipe(
			Effect.tap((source) =>
				Effect.sync(() => {
					source.onmessage = (event) => {
						const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(FrameSchema))(
							event.data
						);
						if (decoded._tag === 'Success') Queue.offerUnsafe(queue, decoded.success);
						else
							Queue.failCauseUnsafe(
								queue,
								Cause.fail(new StudioStreamFailed({ message: 'Studio returned an invalid event.' }))
							);
					};
				})
			)
		)
	);
	const observe = attach(() =>
		load().pipe(
			Effect.andThen(
				typeof EventSource === 'undefined'
					? Effect.void
					: events.pipe(
							Stream.runForEach((frame) => {
								if (view === null) return Effect.void;
								if (
									((frame.kind === 'source' && frame.commit !== view.commit) ||
										frame.kind === 'mr') &&
									!busy
								)
									return load();
								return Effect.sync(() => {
									if (frame.kind === 'log' && view !== null)
										view = { ...view, log: foldLog(view.log, frame.line) };
									else if (frame.kind === 'phase')
										phases = { ...foldPhase(phases, frame.phase, frame.state) };
								});
							})
						)
			),
			Effect.catch((cause) =>
				Effect.sync(() => {
					error = cause.message;
				})
			)
		)
	);
	const run = Effect.fn('Studio.run')(
		function* (op: StudioOp) {
			busy = true;
			error = null;
			const r = yield* Effect.result(api.studioRun(op));
			if (r._tag === 'Failure') return ((error = r.failure.message), false);
			view = r.success;
			return true;
		},
		(effect) =>
			effect.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
	);
	const save = Effect.fn('Studio.save')(function* () {
		if (view === null || Object.keys(drafts).length === 0) return true;
		const saved = $state.snapshot(drafts);
		const ok = yield* run({ op: 'save', expected: view.commit, files: saved });
		// an edit made while the save was in flight is newer than what was saved: it stays a draft
		if (ok) drafts = settleDrafts(drafts, saved);
		return ok;
	});
	const publish = Effect.fn('Studio.publish')(function* () {
		if (yield* save()) yield* run({ op: 'publish' });
	});
	/** A source rollback: the deployment's build runs again as a new deployment; a schema change loses later data. */
	const rollback = Effect.fn('Studio.rollback')(function* (commit: string) {
		const lost = releases.find((r) => r.commit === commit)?.discards;
		const asked =
			lost === undefined
				? t(
						'Roll back live to this commit? Its build runs again as a new deployment and live keeps all its data. The workbench keeps its source.'
					)
				: `${t('Roll back live to this commit? Its schema differs from live’s, so the data written after')} ${new Date(lost).toLocaleString()} ${t('will be lost. Its build runs again as a new deployment.')}`;
		if (confirm(asked))
			yield* run({
				op: 'rollback',
				commit,
				...(lost === undefined ? {} : { discardDataSince: lost })
			});
	});
	let build = $state<{ commit: string; record: StudioBuildRecord | null } | null>(null);
	let showBuild = $state(false);
	const openBuild = Effect.fn('Studio.openBuild')(function* (commit: string) {
		error = null;
		const r = yield* Effect.result(api.studioBuild(commit));
		if (r._tag === 'Failure') return void (error = r.failure.message);
		build = { commit, record: r.success };
		showBuild = true;
		browsing = false;
	});
	function edit(value: string): void {
		if (view?.files[file] === value) delete drafts[file];
		else drafts[file] = value;
	}
	const openMr = Effect.fn('Studio.openMr')(function* () {
		const title = prompt(t('Merge request title'))?.trim();
		if (title && (yield* save())) yield* run({ op: 'mr.open', title });
	});
	const switchTo = Effect.fn('Studio.switchTo')(function* (target: string) {
		if (Object.keys(drafts).length > 0 && !confirm(t('Discard unsaved drafts and switch?'))) return;
		drafts = {};
		if (yield* run({ op: 'switch', target })) go('workbench');
	});
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
		if (showPreview && view?.preview === null) fork(run({ op: 'preview' }));
	}
	const files = $derived(
		view === null ? [] : [...new Set([...Object.keys(view.files), ...Object.keys(drafts)])].sort()
	);
	const source = $derived(drafts[file] ?? view?.files[file] ?? '');
	const target = $derived(view?.target ?? 'workbench');
	const mrs = $derived(view?.mergeRequests ?? []);
	/** A merge request the viewer may switch to and tend: any for an administrator, else one over their own branch. */
	const mine = (m: StudioMergeRequest) =>
		admin || (m.branch !== undefined && m.branch === view?.branch);
	const open = $derived(mrs.filter((m) => (m.state === 'draft' || m.state === 'ready') && mine(m)));
	const current = $derived(mrs.find((m) => m.id === selected) ?? null);
	const releases = $derived(view?.releases ?? []);
	const release = $derived(
		releases.find((r) => r.commit === releaseAt) ?? releases.find((r) => r.current) ?? releases[0]
	);
	const draftCount = $derived(Object.keys(drafts).length);
	const short = (commit: string) => commit.slice(0, 8);
	const FRESH = { current: 'Current', live_advanced: 'Live moved on', terminal: 'Closed' } as const;
	const OWNER = { author: 'Author', reviewer: 'Reviewer', complete: 'Done' } as const;
	const ROW =
		'w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/70 aria-[current=true]:bg-primary/5';
</script>

<span hidden {@attach observe}></span>

<!-- the navigator rail beside the pane (a bottom sheet on a phone) and the pane -->
{#snippet frame(navigator: Snippet, main: Snippet, top?: Snippet)}
	<Stack gap="none" fill class="min-h-0 {INSET_X_CLASS}">
		{@render top?.()}
		<Inline align="stretch" gap="none" grow class="min-h-0 min-w-0">
			<aside
				class="hidden w-72 shrink-0 border-r border-border/60 bg-card md:block"
				aria-label={t('Workspace navigator')}
			>
				<Stack gap="none" fill class="min-h-0">{@render navigator()}</Stack>
			</aside>
			<div class="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
				{@render main()}
			</div>
		</Inline>
	</Stack>
{/snippet}

{#snippet railHeading(icon: string, label: string)}
	<Inline gap="xs" shrink={false} class="border-b border-border/60 px-3 py-1.5">
		<Icon name={icon} class="size-3.5 text-muted-foreground" /><span
			class="text-overline text-foreground">{label}</span
		>
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
		<button
			type="button"
			class={ROW}
			aria-current={selected === null}
			onclick={() => {
				selected = null;
				browsing = false;
			}}
		>
			<span class="block truncate text-xs font-medium text-foreground">{t('My draft')}</span>
			<span class="block truncate font-mono text-micro text-muted-foreground"
				>{#if view?.branch !== undefined}{view.branch} ·
				{/if}{short(view?.commit ?? '')}</span
			>
			<span class="mt-1 block truncate text-micro text-muted-foreground"
				>{view?.changes.length ?? 0}
				{t('changed files')}{#if (view?.behind ?? 0) > 0}
					· {view?.behind} {t('behind live')}{/if}</span
			>
		</button>
		{#if view?.mergeRequests !== undefined}
			<p class="px-2 pt-2 text-overline">{t('Merge requests')}</p>
			{#each [...mrs].reverse() as m (m.id)}
				<button
					type="button"
					class={ROW}
					data-state={m.state}
					aria-current={m.id === selected}
					onclick={() => {
						selected = m.id;
						browsing = false;
					}}
				>
					<span class="block truncate text-xs font-medium text-foreground">!{m.id} {m.title}</span>
					<span class="block truncate font-mono text-micro text-muted-foreground"
						>{m.openedBy} · {short(m.head)}…{short(m.base)}</span
					>
					<span class="mt-1 block truncate text-micro text-muted-foreground"
						>{t(FRESH[reviewFreshness(m)])} · {t('next')}: {t(
							OWNER[reviewNextOwner(m)]
						)}{#if m.readyAt !== null && reviewFreshness(m) !== 'terminal'}
							· {t('in review')} {reviewAge(m.readyAt, Date.now())}{/if}</span
					>
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
			<button
				type="button"
				class={ROW}
				aria-current={r.commit === release?.commit}
				onclick={() => {
					releaseAt = r.commit;
					browsing = false;
				}}
			>
				<span class="block truncate font-mono text-xs font-medium text-foreground"
					>{r.commit.slice(0, 12)}</span
				>
				{#if r.current}<span class="mt-1 block text-micro text-muted-foreground"
						>{t('Serving now')}</span
					>{/if}
				{#if r.rollback !== undefined}<span class="mt-1 block text-micro text-muted-foreground"
						>{t('Rolled back to')} <code class="font-mono">{short(r.rollback)}</code></span
					>{/if}
				<span class="block truncate text-micro text-foreground">{r.message}</span>
				<span class="block text-micro text-muted-foreground"
					><time datetime={r.at}>{new Date(r.at).toLocaleString()}</time></span
				>
				{#if r.checkpoint}<span class="block text-micro text-muted-foreground"
						>{t('checkpoint')}
						<time datetime={r.checkpoint}>{new Date(r.checkpoint).toLocaleString()}</time></span
					>{/if}
			</button>
		{:else}
			<p class="px-1 py-2 text-micro text-muted-foreground">{t('No recorded commits.')}</p>
		{/each}
		{#if release !== undefined}
			{@const built = release.rollback ?? release.commit}
			<Button
				size="sm"
				variant="ghost"
				class="justify-start px-2 text-micro"
				disabled={busy}
				onclick={() => fork(openBuild(built))}
				><Icon name="lucide:scroll-text" class="size-3.5" />{t('Build log of')}
				<code class="font-mono">{short(built)}</code></Button
			>
		{/if}
		{#if (view?.builds?.length ?? 0) > 0}
			<p class="px-2 pt-2 text-overline">{t('Builds')}</p>
			{#each view?.builds ?? [] as b (b.commit)}
				<button
					type="button"
					class={ROW}
					data-status={b.status}
					onclick={() => fork(openBuild(b.commit))}
				>
					<span class="block truncate font-mono text-xs font-medium text-foreground"
						>{short(b.commit)}
						<span class={b.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
							>{t(b.status === 'failed' ? 'failed' : 'built')}</span
						>{#if b.live}
							· {t('live')}{/if}</span
					>
					<span class="block truncate text-micro text-foreground">{b.message}</span>
					<span class="block text-micro text-muted-foreground"
						><time datetime={b.at}>{new Date(b.at).toLocaleString()}</time>{#if b.diagnostics > 0}
							· {b.diagnostics} {t('diagnostics')}{/if}</span
					>
				</button>
			{/each}
		{/if}
	</Scroll>
{/snippet}

{#snippet toolbar()}
	{#if view !== null}
		<WorkbenchToolbar
			{view}
			targets={open}
			{admin}
			{busy}
			drafts={draftCount}
			{phases}
			{error}
			previewing={showPreview}
			{t}
			onswitch={(x) => fork(switchTo(x))}
			onnew={create}
			onsave={() => fork(save())}
			onpreview={togglePreview}
			onrebase={() => fork(run({ op: 'rebase' }))}
			onopenmr={() => fork(openMr())}
			onpublish={() => fork(publish())}
			onreview={() => {
				selected = target;
				go('changes');
			}}
		/>
		{#if (view.conflicts?.length ?? 0) > 0}
			<Inline
				gap="xs"
				shrink={false}
				role="alert"
				class="border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive"
			>
				<Icon name="lucide:triangle-alert" class="size-3 shrink-0" /><span class="truncate text-xs"
					>{t('Resolve the conflict markers in')} {view.conflicts?.join(', ')}</span
				>
			</Inline>
		{/if}
	{/if}
{/snippet}

{#snippet workbenchMain()}
	{#if view !== null}
		{#if showPreview}
			{@const p = view.previewOf}
			<Stack gap="none" fill class="min-h-0">
				<Inline
					gap="xs"
					shrink={false}
					class="flex-wrap border-b border-border/60 px-3 py-1.5 text-micro"
				>
					{#if target === 'workbench'}
						<Button
							size="sm"
							variant="outline"
							class="px-2 text-micro"
							disabled={busy}
							onclick={() => fork(run({ op: 'preview' }))}
						>
							<Icon name="lucide:refresh-cw" class="size-3.5" />{t(
								view.preview === null ? 'Preview on sample data' : 'Rebuild preview'
							)}
						</Button>
						{#if admin}<Button
								size="sm"
								variant="ghost"
								class="px-2 text-micro"
								disabled={busy}
								onclick={() => fork(run({ op: 'preview', live: true }))}
								>{t('Preview on live data')}</Button
							>{/if}
						{#if view.preview !== null}<Button
								size="sm"
								variant="ghost"
								class="px-2 text-micro"
								disabled={busy}
								onclick={() => fork(run({ op: 'exit' }))}>{t('Exit preview')}</Button
							>{/if}
					{/if}
					{#if p !== undefined}
						<span class="text-muted-foreground"
							>{t(p.live ? 'on live data' : 'on sample data')} ·
							<code class="font-mono">{short(p.artifact)}</code>
							{#if p.stale}
								· <span class="text-amber-700 dark:text-amber-300"
									>{t('stale: built from')} <code class="font-mono">{short(p.commit)}</code></span
								>{/if}
							· {t('expires')}
							{new Date(p.expiresAt).toLocaleString()}</span
						>
					{/if}
				</Inline>
				{#if view.preview === null}
					<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
						<Icon
							name={busy ? 'lucide:loader-2' : 'lucide:scan-eye'}
							class="size-8 opacity-30 {busy ? 'animate-spin' : ''}"
						/>
						<p class="text-xs">{busy ? t('Building the preview…') : t('No preview yet.')}</p>
					</Stack>
				{:else}
					<iframe
						title={t('Workbench preview')}
						src={view.preview}
						class="min-h-0 w-full flex-1 border-0 bg-background"
					></iframe>
				{/if}
			</Stack>
		{:else}
			<Stack gap="none" fill class="min-h-0">
				<div class="min-h-0 flex-1">
					<SourceEditor
						path={file}
						value={source ?? ''}
						baseline={view.baseline?.[file]}
						{diff}
						deleted={drafts[file] === null}
						fileCount={files.length}
						against={t(target === 'workbench' ? 'against Live' : 'against MR head')}
						onChange={edit}
						onDiff={() => (diff = !diff)}
						onDelete={() => (drafts[file] = null)}
						{t}
					/>
				</div>
				<DiagnosisPane
					diagnostics={view.diagnostics}
					stale={draftCount > 0}
					{busy}
					onopen={openFile}
					onrerun={() => fork(run({ op: 'preview' }))}
					{t}
				/>
			</Stack>
		{/if}
	{/if}
{/snippet}

{#snippet changesMain()}
	{#if view !== null}
		{#key current?.id ?? ''}
			<ReviewPane
				{view}
				request={current}
				{admin}
				{busy}
				{mine}
				onopen={(p) => {
					openFile(p);
					diff = true;
				}}
				onswitch={(x) => fork(switchTo(x))}
				onopenmr={() => fork(openMr())}
				{run}
				{t}
			/>
		{/key}
	{/if}
{/snippet}

{#snippet liveMain()}
	{#if view !== null}
		<LivePane
			{api}
			{view}
			{release}
			{admin}
			{busy}
			sub={active === 'operations' ? 'operations' : 'runtime'}
			onsub={go}
			onrestore={(c) => fork(rollback(c))}
			{t}
		/>
	{/if}
{/snippet}

{#snippet workbenchTab()}{@render frame(sourceNav, workbenchMain, toolbar)}{/snippet}
{#snippet changesTab()}{@render frame(changesNav, changesMain)}{/snippet}
{#snippet liveTab()}{@render frame(liveNav, liveMain)}{/snippet}

{#snippet browse()}
	<Button
		variant="ghost"
		size="sm"
		class="shrink-0 md:hidden"
		aria-label={t('Open the navigator')}
		onclick={() => (browsing = true)}
	>
		<Icon name="lucide:panel-bottom" class="size-4" />{t('Browse')}
	</Button>
{/snippet}

<Stack gap="none" grow class="min-h-0 bg-background">
	<Stack as="header" gap="xs" shrink={false} class="px-4 pt-3 sm:px-6 sm:pt-6">
		<h1 class="text-heading">{t('Workspace Studio')}</h1>
		<p class="hidden max-w-2xl text-meta sm:block">
			{t('Edit safely, preview the exact result, then ask for review.')}
		</p>
	</Stack>
	{#if view === null}
		<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
			{#if error === null}<Icon name="lucide:loader-2" class="size-6 animate-spin opacity-40" />
				<p class="text-xs">{t('Loading…')}</p>
			{:else}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		</Stack>
	{:else}
		{#if error !== null && root !== 'workbench'}
			<p
				role="alert"
				class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-6"
			>
				{error}
			</p>
		{/if}
		<Tabs
			value={root}
			onValueChange={(v) => go(v === 'changes' ? 'changes' : v === 'live' ? 'live' : 'workbench')}
			trailing={browse}
			class="mt-4 min-h-0 flex-1 gap-3 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6"
			tabs={[
				{ name: 'workbench', title: t('Workbench'), body: workbenchTab, keepAlive: true as const },
				{ name: 'changes', title: t('Changes'), body: changesTab },
				{ name: 'live', title: t('Live'), body: liveTab }
			]}
		/>
	{/if}
</Stack>

<Sheet bind:open={showBuild} title={t('Build')}>
	{#if build !== null}
		<Scroll name={t('Build')} class="h-full">
			<Stack gap="md" class="p-4">
				<p class="text-xs text-foreground">
					<code class="font-mono">{short(build.commit)}</code>
					{#if build.record !== null}
						· {t(build.record.build.status === 'failed' ? 'failed' : 'built')} ·
						<time datetime={build.record.build.at}
							>{new Date(build.record.build.at).toLocaleString()}</time
						>
						· {build.record.build.message}{/if}
				</p>
				{#if build.record === null}
					<p class="text-meta">{t('This build’s log is no longer retained.')}</p>
				{:else}
					<DiagnosisPane
						diagnostics={build.record.diagnostics}
						onopen={(p) => {
							showBuild = false;
							openFile(p);
						}}
						{t}
					/>
					<BuildLog lines={build.record.log} {t} />
				{/if}
			</Stack>
		</Scroll>
	{/if}
</Sheet>

{#if view !== null}
	<Sheet bind:open={browsing} title={t('Workspace navigator')}>
		<Stack gap="none" fill class="min-h-0">
			{#if root === 'workbench'}{@render sourceNav()}{:else if root === 'changes'}{@render changesNav()}{:else}{@render liveNav()}{/if}
		</Stack>
	</Sheet>
{/if}
