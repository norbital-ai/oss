<!--
	Changes' main pane : the selected change as a header (title, state, how far behind live, who and what it is, its
	merge in progress or why the last one failed) over its views: Files (each changed file's Before beside After),
	Preview (the change's own preview of a commit — with its tests, which run against a commit, never a draft — beside
	Tests), Manifest and Logs (diagnosis and the change's log). Previewing builds the latest commit when the viewer
	works on the change; Files, Preview and Manifest are that change, so another change offers to work on it first.
-->
<script lang="ts">
	import { Button, CodeEditor, Icon, TabStrip } from '@norbital-ai/ui';
	import { fork } from '@norbital-ai/ui/effect';
	import type { Effect } from 'effect';
	import { Cluster, Columns, Scroll, Stack } from '@norbital-ai/ui/layout';
	import BuildLog from './BuildLog.svelte';
	import DiagnosisPane from './DiagnosisPane.svelte';
	import ManifestPane from './ManifestPane.svelte';
	import PreviewFrame from '../preview/PreviewFrame.svelte';
	import { impactLines } from '../../protocol/migration-impact.ts';
	import {
		ageText,
		languageOf,
		type StudioChangeSet,
		type StudioOp,
		type StudioView
	} from './model.ts';

	let {
		view,
		change,
		busy,
		onopen,
		onpreview,
		onrelease,
		progress,
		run,
		t
	}: {
		view: StudioView;
		change: StudioChangeSet | null;
		busy: boolean;
		onopen: (path: string) => void;
		/** Build the viewer's change's preview of its latest commit. */
		onpreview: () => void;
		/** Take the viewer's change's preview back from Norbius. */
		onrelease: () => void;
		/** A running build's step and elapsed time. */
		progress?: string | undefined;
		run: (op: StudioOp) => Effect.Effect<boolean>;
		t: (key: string) => string;
	} = $props();

	/** Files, Preview and Manifest are what the viewer works on: their change, or live with none selected. */
	const mine = $derived(change === null || change.id === view.change);
	const open = $derived(change?.state === 'open');
	let sub = $state('files');
	const short = (commit: string) => commit.slice(0, 8);
	const views = $derived([
		{ name: 'files', title: t('Files'), body: files },
		...(change === null ? [] : [{ name: 'preview', title: t('Preview'), body: preview }]),
		...(mine ? [{ name: 'manifest', title: t('Manifest'), body: manifest }] : []),
		{ name: 'logs', title: t('Logs'), body: logs }
	]);
	const active = $derived(views.some((v) => v.name === sub) ? sub : 'files');
	/** Selecting Preview shows the change's preview and, when the viewer works on it, builds the head it does not serve yet. */
	function select(name: string): void {
		sub = name;
		if (
			name === 'preview' &&
			change !== null &&
			change.id === view.change &&
			(change.preview === null || change.preview.stale)
		)
			onpreview();
	}
</script>

{#snippet pill(text: string)}
	<span class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-foreground"
		>{text}</span
	>
{/snippet}

{#snippet files()}
	<Scroll name={t('Files')} size="fill">
		<Stack gap="sm" class="p-3">
			{#if !mine && change !== null}
				{@const c = change}
				<Stack gap="sm" align="start">
					<p class="inline-flex items-center gap-1.5 text-meta">
						<Icon name="lucide:git-compare" class="size-3.5 shrink-0" />
						{t('Work on this change to see its files.')}
					</p>
					{#if open}<Button
							disabled={busy}
							onclick={() => fork(run({ op: 'change.open', id: c.id }))}>{t('Work on it')}</Button
						>{/if}
				</Stack>
			{:else}
				{#if view.changes.length > 0}
					<p class="text-meta">
						{t('against the Live commit this change left from')}
					</p>
				{/if}
				{#each view.changes as c (c.path)}
					{@const before = c.baseline ?? null}
					<Stack gap="none" class="max-w-full overflow-hidden rounded-md border border-border/70">
						<button
							type="button"
							class="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-2 text-left font-mono text-xs text-foreground hover:bg-muted/60"
							onclick={() => onopen(c.path)}
						>
							<span
								class="font-semibold {c.change === 'added'
									? 'text-success'
									: c.change === 'deleted'
										? 'text-destructive'
										: 'text-warning-foreground dark:text-warning'}"
								>{c.change === 'added' ? 'A' : c.change === 'deleted' ? 'D' : 'M'}</span
							>
							<span class="min-w-0 truncate">{c.path}</span>
						</button>
						<Columns count={2} gap="none" collapse="narrow">
							<Stack gap="xs" class="min-h-0 min-w-0 p-3">
								<span class="text-micro font-medium text-foreground">{t('Before')}</span>
								{#if before === null}<span class="text-micro text-muted-foreground">∅</span>{/if}
								<CodeEditor
									aria-label={`${c.path} (baseline)`}
									value={before ?? ''}
									language={languageOf(c.path)}
									readonly
									minHeight="7rem"
									class="max-h-80 w-full rounded-none border-0 shadow-none"
								/>
							</Stack>
							<Stack
								gap="xs"
								class="min-h-0 min-w-0 border-t border-border/60 p-3 @min-[40rem]:border-t-0 @min-[40rem]:border-l"
							>
								<span class="text-micro font-medium text-foreground">{t('After')}</span>
								{#if c.change === 'deleted'}<span class="text-micro text-muted-foreground">∅</span
									>{/if}
								<CodeEditor
									aria-label={c.path}
									value={c.text ?? ''}
									language={languageOf(c.path)}
									readonly
									minHeight="7rem"
									class="max-h-80 w-full rounded-none border-0 shadow-none"
								/>
							</Stack>
						</Columns>
					</Stack>
				{:else}
					<p class="text-meta">{t('This change matches live.')}</p>
				{/each}
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet preview()}
	{#if change !== null}
		{@const c = change}
		{@const mineChange = c.id === view.change}
		{@const building = mineChange ? progress : undefined}
		{#if c.preview === null || c.preview.url === null || c.preview.stale}
			<Stack gap="sm" align="center" justify="center" size="fill" class="text-muted-foreground">
				<Icon
					name={building === undefined ? 'lucide:scan-eye' : 'lucide:loader-2'}
					class="size-8 opacity-30 {building === undefined ? '' : 'animate-spin'}"
				/>
				<p class="text-xs" role={building === undefined ? undefined : 'status'}>
					{building ??
						(c.preview === null
							? t('No preview yet.')
							: c.preview.stale
								? t('Preview is out of date.')
								: t('Preview shelved while idle — working on the change brings it back'))}
				</p>
				{#if open && mineChange}
					<Button disabled={busy} onclick={onpreview}>{t('Preview')}</Button>
				{/if}
			</Stack>
		{:else}
			<div class="relative flex min-h-0 flex-1 flex-col">
				<PreviewFrame
					src={c.preview.url}
					tests={mineChange ? view.tests : undefined}
					version={c.preview.artifact}
					title={t('Change preview')}
					label={`${t('Change')} ${c.id} · ${c.title}`}
					status={building}
					{t}
				>
					{#snippet details()}
						<div class="space-y-2 text-xs leading-relaxed">
							<p class="font-medium text-foreground">{t('Preview of this change')}</p>
							<p>
								{t('It runs on its own copy of live data and closes after two idle hours.')}
							</p>
						</div>
					{/snippet}
				</PreviewFrame>
				{#if mineChange && view.previewControl?.holder === 'norbius'}
					<div
						class="bg-background/70 absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[1px]"
					>
						<div
							class="border-border bg-card flex max-w-sm flex-col items-center gap-2 rounded-lg border p-4 text-center"
						>
							<Icon name="lucide:bot" class="size-5" />
							<p class="text-sm font-medium">{t('Norbius is using this preview')}</p>
							<p class="text-muted-foreground text-xs">
								{t('Take control to use it yourself; Norbius is told you did.')}
							</p>
							<Button disabled={busy} onclick={onrelease}>{t('Take control')}</Button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet manifest()}
	<Stack gap="none" size="fill" class="px-3">
		<ManifestPane {view} {onopen} {t} />
	</Stack>
{/snippet}

{#snippet logs()}
	<Scroll name={t('Logs')} size="fill">
		<Stack gap="md" class="p-3">
			{#if change?.diagnostics !== undefined}
				<div class="overflow-hidden rounded-md">
					<DiagnosisPane diagnostics={change.diagnostics} {onopen} {t} />
				</div>
			{/if}
			<BuildLog
				lines={change === null ? view.log : [...change.log, ...(mine ? view.log : [])]}
				{t}
			/>
		</Stack>
	</Scroll>
{/snippet}

<Stack gap="none" size="fill">
	<Stack gap="sm" class="border-b border-border/60 p-3">
		{#if change === null}
			<p class="text-meta">
				{t(
					'A change is a named set of edits from live, with its own preview on a copy of live’s data.'
				)}
			</p>
		{:else}
			{@const c = change}
			<Stack gap="xs" size="fill" class="min-w-0">
				<Cluster gap="xs">
					<h2 class="text-xs font-semibold text-foreground">
						{t('Change')}
						{c.id} · {c.title}
					</h2>
					{@render pill(
						t(c.state === 'open' ? 'Open' : c.state === 'merged' ? 'Merged' : 'Closed')
					)}
					{#if mine}{@render pill(t('You work on this'))}{/if}
					{#if c.behind > 0}{@render pill(`${c.behind} ${t('behind live')}`)}{/if}
				</Cluster>
				<p class="font-mono text-micro break-all text-muted-foreground">
					{c.branch} · {short(c.base)}…{short(c.head)}
				</p>
				<p class="text-meta">
					{t('by')}
					{c.openedBy} · {t('updated')}
					{ageText(c.updatedAt, Date.now())}
				</p>
			</Stack>
			{#if c.merge !== undefined}
				<p
					class="text-xs {c.merge.state === 'failed'
						? 'text-destructive'
						: 'text-muted-foreground'}"
					role={c.merge.state === 'failed' ? 'alert' : 'status'}
				>
					{#if c.merge.state === 'running'}{t(
							'Merging into live…'
						)}{:else if c.merge.state === 'scheduled'}{t('Merges at')}
						{new Date(c.merge.runAt ?? c.merge.at).toLocaleString()}{:else}{t(
							'The merge failed'
						)}{#if c.merge.error !== undefined}:
							{c.merge.error}{/if}{/if}
				</p>
			{/if}
			{#if c.preview !== null && c.preview.url === null}
				<p class="text-meta">
					{t('Preview shelved while idle — working on the change brings it back')}
				</p>
			{/if}
			{#if c.preview?.stale}
				<p class="text-meta text-warning-foreground dark:text-warning">
					{t('building the newest edits')}
				</p>
			{/if}
			{#if (c.preview?.destructive?.length ?? 0) > 0}
				<p class="text-meta text-destructive">
					{t('merging applies destructive schema steps:')}
					<code class="font-mono">{c.preview?.destructive?.join(', ')}</code>
				</p>
			{/if}
			{#if c.preview?.impact !== undefined}
				<ul class="text-meta" aria-label={t('What merging does')}>
					{#each impactLines(c.preview.impact, t) as line, i (i)}<li>{line}</li>{/each}
				</ul>
			{/if}
		{/if}
	</Stack>
	<TabStrip
		items={views.map(({ name, title }) => ({ name, title }))}
		value={active}
		onValueChange={select}
		label={t('Change views')}
		level={2}
	/>
	{@const chosen = views.find((v) => v.name === active)}
	<div
		role="tabpanel"
		aria-label={t('Change view')}
		class="min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto"
	>
		{#if chosen !== undefined}{@render chosen.body()}{/if}
	</div>
</Stack>
