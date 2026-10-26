<!--
	Changes' main pane : the selected change as a header (title, state, how far behind live, its preview and a merge in
	progress or why the last one failed, who and what it is, its actions: Work on it, Merge, Close) over its views: Files
	(each changed file's Before beside After), Manifest and Logs (diagnosis and the change's log). Files and Manifest are
	the change the viewer works on, so another change offers to work on it first.
-->
<script lang="ts">
	import { Button, CodeEditor, confirmAction, Icon, Tabs } from '@norbital-ai/ui';
	import { fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { Cluster, Columns, Scroll, Stack } from '@norbital-ai/ui/layout';
	import BuildLog from './BuildLog.svelte';
	import DiagnosisPane from './DiagnosisPane.svelte';
	import ManifestPane from './ManifestPane.svelte';
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
		admin,
		busy,
		onopen,
		onnew,
		onmerge,
		run,
		t
	}: {
		view: StudioView;
		change: StudioChangeSet | null;
		admin: boolean;
		busy: boolean;
		onopen: (path: string) => void;
		onnew: () => void;
		onmerge: (change: StudioChangeSet) => void;
		run: (op: StudioOp) => Effect.Effect<boolean>;
		t: (key: string) => string;
	} = $props();

	/** Files and Manifest are what the viewer works on: their change, or live with none selected. */
	const mine = $derived(change === null || change.id === view.change);
	const open = $derived(change?.state === 'open');
	let sub = $state('files');
	const short = (commit: string) => commit.slice(0, 8);
	const STATE = { open: 'Open', merged: 'Merged', closed: 'Closed' } as const;
	const views = $derived([
		{ name: 'files', title: t('Files'), body: files },
		...(mine ? [{ name: 'manifest', title: t('Manifest'), body: manifest }] : []),
		{ name: 'logs', title: t('Logs'), body: logs }
	]);
	const PANE = 'min-h-0 flex-1 gap-0 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6';
</script>

{#snippet pill(text: string)}
	<span class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-foreground"
		>{text}</span
	>
{/snippet}

{#snippet files()}
	<Scroll name={t('Files')} class="h-full">
		<Stack gap="sm" class="p-4 sm:p-6">
			{#if !mine && change !== null}
				{@const c = change}
				<Stack gap="sm" align="center" class="py-12 text-center text-muted-foreground">
					<Icon name="lucide:git-compare" class="size-8 opacity-30" />
					<p class="text-xs">{t('Work on this change to see its files.')}</p>
					{#if open}<Button
							size="sm"
							disabled={busy}
							onclick={() => fork(run({ op: 'change.open', id: c.id }))}>{t('Work on it')}</Button
						>{/if}
				</Stack>
			{:else}
				<p class="text-micro text-muted-foreground">
					{t('against the Live commit this change left from')}
				</p>
				{#each view.changes as c (c.path)}
					{@const before = c.baseline ?? null}
					<Stack gap="none" class="max-w-full overflow-hidden rounded-md border border-border/70">
						<button
							type="button"
							class="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-2 text-left font-mono text-micro text-foreground hover:bg-muted/60"
							onclick={() => onopen(c.path)}
						>
							<span
								class="font-semibold {c.change === 'added'
									? 'text-emerald-700 dark:text-emerald-300'
									: c.change === 'deleted'
										? 'text-destructive'
										: 'text-amber-700 dark:text-amber-300'}"
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

{#snippet manifest()}
	<ManifestPane {view} {onopen} {t} />
{/snippet}

{#snippet logs()}
	<Scroll name={t('Logs')} class="h-full">
		<Stack gap="lg" class="p-4 sm:p-6">
			{#if change?.diagnostics !== undefined}
				<div class="overflow-hidden rounded-md border border-border/70">
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

<Stack gap="none" fill class="min-h-0">
	<Stack gap="sm" shrink={false} class="border-b border-border/60 px-4 py-3 sm:px-6">
		{#if change === null}
			<Cluster align="start" gap="sm">
				<p class="grow text-xs text-muted-foreground">
					{t(
						'A change is a named set of edits from live, with its own preview on a copy of live’s data.'
					)}
				</p>
				<Button size="sm" variant="outline" disabled={busy} onclick={onnew}>
					<Icon name="lucide:git-branch-plus" class="size-3.5" />{t('New change')}
				</Button>
			</Cluster>
		{:else}
			{@const c = change}
			<Cluster align="start" gap="sm">
				<Stack gap="xs" grow class="min-w-0">
					<Cluster gap="xs">
						<h2 class="text-sm font-semibold text-foreground">!{c.id} {c.title}</h2>
						{@render pill(t(STATE[c.state]))}
						{#if mine}{@render pill(t('You work on this'))}{/if}
						{#if c.behind > 0}{@render pill(`${c.behind} ${t('behind live')}`)}{/if}
					</Cluster>
					<p class="font-mono text-micro text-muted-foreground">
						{c.branch} · {short(c.base)}…{short(c.head)}
					</p>
					<p class="text-micro text-muted-foreground">
						{t('by')}
						{c.openedBy} · {t('updated')}
						{ageText(c.updatedAt, Date.now())}
					</p>
				</Stack>
				{#if open}
					<Cluster gap="xs" shrink={false}>
						{#if !mine}<Button
								size="sm"
								disabled={busy}
								onclick={() => fork(run({ op: 'change.open', id: c.id }))}>{t('Work on it')}</Button
							>{/if}
						{#if admin}
							<Button
								size="sm"
								disabled={busy || c.merge?.state === 'running'}
								onclick={() => onmerge(c)}
							>
								<Icon name="lucide:git-merge" class="size-3.5" />{t('Merge')}
							</Button>
						{/if}
						<Button
							size="sm"
							variant="ghost"
							disabled={busy || c.merge?.state === 'running'}
							onclick={() =>
								fork(
									confirmAction({
										title: t('Close this change?'),
										body: t(
											'Its edits stay in history; its preview and its copy of the data are deleted.'
										),
										confirmLabel: t('Close'),
										cancelLabel: t('Cancel'),
										destructive: true
									}).pipe(
										Effect.flatMap((confirmed) =>
											confirmed ? run({ op: 'change.close', id: c.id }) : Effect.void
										)
									)
								)}>{t('Close')}</Button
						>
					</Cluster>
				{/if}
			</Cluster>
			{#if c.merge !== undefined}
				<p
					class="text-micro {c.merge.state === 'failed'
						? 'text-destructive'
						: 'text-muted-foreground'}"
					role={c.merge.state === 'failed' ? 'alert' : 'status'}
				>
					{#if c.merge.state === 'running'}{t('Merging into live…')}{:else}{t(
							'The merge failed'
						)}{#if c.merge.error !== undefined}:
							{c.merge.error}{/if}{/if}
				</p>
			{/if}
			{#if c.preview !== null}
				<p class="text-micro text-muted-foreground">
					{#if c.preview.url !== null}<a
							class="text-primary hover:underline"
							href={c.preview.url}
							target="_blank"
							rel="noreferrer">{t('Preview')}</a
						>{:else}{t('Preview shelved while idle — working on the change brings it back')}{/if}
					{#if c.preview.stale}
						· <span class="text-amber-700 dark:text-amber-300"
							>{t('building the newest edits; serving')}
							<code class="font-mono">{short(c.preview.commit)}</code></span
						>{/if}
					{#if (c.preview.destructive?.length ?? 0) > 0}
						· <span class="text-destructive"
							>{t('merging applies destructive schema steps:')}
							<code class="font-mono">{c.preview.destructive?.join(', ')}</code></span
						>{/if}
				</p>
			{/if}
		{/if}
	</Stack>
	<Tabs
		value={views.some((v) => v.name === sub) ? sub : 'files'}
		onValueChange={(v) => (sub = v)}
		orientation="horizontal"
		class={PANE}
		tabs={views}
	/>
</Stack>
