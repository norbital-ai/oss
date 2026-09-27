<!--
	Changes' main pane (staging's review-pane): the selected change — the viewer's own draft or a merge request — as a header
	(title, freshness, the draft → ready → merged rail, who and what it is, its actions) over its views: Files (each changed
	file's Before beside After), Manifest, Conversation (comments and the review decision) and Logs (diagnosis and the build
	log). Files and Manifest describe the viewer's target, so another merge request offers to switch to it first.
-->
<script lang="ts">
	import { Button, CodeEditor, Icon, Tabs, Textarea } from '@norbital-ai/ui';
	import { Cluster, Columns, Scroll, Stack } from '@norbital-ai/ui/layout';
	import BuildLog from './BuildLog.svelte';
	import DiagnosisPane from './DiagnosisPane.svelte';
	import ManifestPane from './ManifestPane.svelte';
	import { languageOf, reviewAge, reviewFreshness, reviewNextOwner, type StudioMergeRequest, type StudioOp, type StudioView } from '../studio.ts';

	let { view, request, admin, busy, mine, onopen, onswitch, onopenmr, run, t }: {
		view: StudioView; request: StudioMergeRequest | null; admin: boolean; busy: boolean; mine: (m: StudioMergeRequest) => boolean;
		onopen: (path: string) => void; onswitch: (target: string) => void; onopenmr: () => void; run: (op: StudioOp) => Promise<boolean>;
		t: (key: string) => string;
	} = $props();

	const target = $derived(view.target ?? 'workbench');
	/** Files and Manifest are the viewer's target's: the draft, or the merge request they switched to. */
	const onTarget = $derived(request === null ? target === 'workbench' : target === request.id);
	const open = $derived(request !== null && (request.state === 'draft' || request.state === 'ready'));
	let sub = $state('files');
	let reason = $state('');
	let comment = $state('');
	const short = (commit: string) => commit.slice(0, 8);
	const RAIL = [['draft', 'Draft'], ['ready', 'Ready for review'], ['merged', 'Merged']] as const;
	const reached = (m: StudioMergeRequest, stage: 'draft' | 'ready' | 'merged') =>
		m.state !== 'closed' && (stage === 'draft' || (stage === 'ready' ? m.state !== 'draft' : m.state === 'merged'));
	const FRESH = { current: 'Current', live_advanced: 'Live moved on', terminal: 'Closed' } as const;
	const OWNER = { author: 'Author', reviewer: 'Reviewer', complete: 'Done' } as const;
	const views = $derived([
		{ name: 'files', title: t('Files'), body: files },
		...(onTarget ? [{ name: 'manifest', title: t('Manifest'), body: manifest }] : []),
		...(request === null ? [] : [{ name: 'conversation', title: t('Conversation'), body: conversation }]),
		{ name: 'logs', title: t('Logs'), body: logs }
	]);
	const PANE = 'min-h-0 flex-1 gap-0 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6';
</script>

{#snippet pill(text: string)}
	<span class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-foreground">{text}</span>
{/snippet}

{#snippet previewControls(preview: { url?: string; live: boolean; commit: string; expiresAt: string; stale: boolean } | null, url: string | null)}
	<Cluster gap="xs" class="text-micro">
		<Button size="sm" variant="outline" disabled={busy} onclick={() => void run({ op: 'preview' })}>
			<Icon name="lucide:scan-eye" class="size-3.5" />{t(preview === null ? 'Preview on sample data' : 'Rebuild preview')}
		</Button>
		{#if admin}<Button size="sm" variant="ghost" disabled={busy} onclick={() => void run({ op: 'preview', live: true })}>{t('Preview on live data')}</Button>{/if}
		{#if preview !== null}
			<Button size="sm" variant="ghost" disabled={busy} onclick={() => void run({ op: 'exit' })}>{t('Exit preview')}</Button>
			<span class="text-muted-foreground">
				{#if url !== null}<a class="text-primary hover:underline" href={url} target="_blank" rel="noreferrer">{t(preview.live ? 'on live data' : 'on sample data')}</a>{:else}{t(preview.live ? 'on live data' : 'on sample data')}{/if}
				{#if preview.stale} · <span class="text-amber-700 dark:text-amber-300">{t('stale: built from')} <code class="font-mono">{short(preview.commit)}</code></span>{/if}
				· {t('expires')} {new Date(preview.expiresAt).toLocaleString()}
			</span>
		{/if}
	</Cluster>
{/snippet}

{#snippet files()}
	<Scroll name={t('Files')} class="h-full">
		<Stack gap="sm" class="p-4 sm:p-6">
			{#if !onTarget && request !== null}
				<Stack gap="sm" align="center" class="py-12 text-center text-muted-foreground">
					<Icon name="lucide:git-compare" class="size-8 opacity-30" />
					<p class="text-xs">{t('Switch to this merge request to see its files.')}</p>
					{#if open && mine(request)}<Button size="sm" disabled={busy} onclick={() => onswitch(request.id)}>{t('Edit')}</Button>{/if}
				</Stack>
			{:else}
				<p class="text-micro text-muted-foreground">{t('against the Live commit this change sits on')}</p>
				{#each view.changes as c (c.path)}
					{@const before = view.baseline?.[c.path] ?? null}
					<Stack gap="none" class="max-w-full overflow-hidden rounded-md border border-border/70">
						<button type="button" class="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-2 text-left font-mono text-micro text-foreground hover:bg-muted/60" onclick={() => onopen(c.path)}>
							<span class="font-semibold {c.change === 'added' ? 'text-emerald-700 dark:text-emerald-300' : c.change === 'deleted' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}">{c.change === 'added' ? 'A' : c.change === 'deleted' ? 'D' : 'M'}</span>
							<span class="min-w-0 truncate">{c.path}</span>
						</button>
						<Columns count={2} gap="none" collapse="narrow">
							<Stack gap="xs" class="min-h-0 min-w-0 p-3">
								<span class="text-micro font-medium text-foreground">{t('Before')}</span>
								{#if before === null}<span class="text-micro text-muted-foreground">∅</span>{/if}
								<CodeEditor aria-label={`${c.path} (baseline)`} value={before ?? ''} language={languageOf(c.path)} readonly minHeight="7rem" class="max-h-80 w-full rounded-none border-0 shadow-none" />
							</Stack>
							<Stack gap="xs" class="min-h-0 min-w-0 border-t border-border/60 p-3 @min-[40rem]:border-t-0 @min-[40rem]:border-l">
								<span class="text-micro font-medium text-foreground">{t('After')}</span>
								{#if c.change === 'deleted'}<span class="text-micro text-muted-foreground">∅</span>{/if}
								<CodeEditor aria-label={c.path} value={view.files[c.path] ?? ''} language={languageOf(c.path)} readonly minHeight="7rem" class="max-h-80 w-full rounded-none border-0 shadow-none" />
							</Stack>
						</Columns>
					</Stack>
				{:else}
					<p class="text-meta">{t('The workbench matches live.')}</p>
				{/each}
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet manifest()}
	<ManifestPane {view} {onopen} {t} />
{/snippet}

{#snippet conversation()}
	{#if request !== null}
		{@const m = request}
		<Scroll name={t('Conversation')} class="h-full">
			<Stack gap="lg" class="p-4 sm:p-6">
				{#if m.decision !== null}
					<p class="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
						<span class="font-medium text-foreground">{t(m.decision.kind === 'approved' ? 'Approved' : m.decision.kind === 'rejected' ? 'Rejected' : 'Changes requested')}</span>
						{t('by')} {m.decision.by}{#if m.decision.artifact !== undefined} · {t('artifact')} <code class="font-mono">{short(m.decision.artifact)}</code>{/if}
						{#if m.decision.commit !== m.head} · {t('on an earlier commit')}{/if}{#if m.decision.reason} · {m.decision.reason}{/if}
					</p>
				{/if}
				{#if (m.destructive?.length ?? 0) > 0}
					<p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{t('Destructive schema steps an approval accepts:')} <code class="font-mono">{m.destructive?.join(', ')}</code></p>
				{/if}
				<Stack gap="sm" class="rounded-md border border-border/70 p-3">
					<h3 class="text-xs font-semibold text-foreground">{t('Comment')}</h3>
					{#each m.comments as c, i (i)}
						<Stack gap="xs">
							<p class="text-micro text-muted-foreground">{c.by} · <time datetime={c.at}>{new Date(c.at).toLocaleString()}</time></p>
							<p class="text-xs whitespace-pre-wrap text-foreground">{c.text}</p>
						</Stack>
					{:else}
						<p class="text-meta">{t('No comments yet.')}</p>
					{/each}
					{#if mine(m) && open}
						<Textarea bind:value={comment} rows={3} placeholder={t('Leave a comment')} aria-label={t('Comment')} />
						<Button size="sm" class="w-fit" disabled={busy || comment.trim() === ''}
							onclick={async () => { if (await run({ op: 'mr.comment', id: m.id, text: comment.trim() })) comment = ''; }}>{t('Comment')}</Button>
					{/if}
				</Stack>
				{#if admin && open}
					<Stack gap="sm" class="rounded-md border border-border/70 p-3">
						<h3 class="text-xs font-semibold text-foreground">{t('Decision')}</h3>
						<Textarea bind:value={reason} rows={3} placeholder={t('What should change?')} aria-label={t('Reason')} />
						<Cluster gap="xs">
							<Button size="sm" disabled={busy} onclick={() => void run({ op: 'mr.decide', id: m.id, kind: 'approved' })}>{t('Approve')}</Button>
							<Button size="sm" variant="outline" disabled={busy || reason.trim() === ''}
								onclick={async () => { if (await run({ op: 'mr.decide', id: m.id, kind: 'changes_requested', reason: reason.trim() })) reason = ''; }}>{t('Request changes')}</Button>
							<Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" disabled={busy || reason.trim() === ''}
								onclick={async () => { if (await run({ op: 'mr.decide', id: m.id, kind: 'rejected', reason: reason.trim() })) reason = ''; }}>{t('Reject')}</Button>
						</Cluster>
					</Stack>
				{:else if open && reviewFreshness(m) === 'live_advanced'}
					<p class="text-xs text-amber-700 dark:text-amber-300">{t('Live moved on. Rebase before review.')}</p>
				{:else if m.state === 'ready'}
					<p class="text-xs text-muted-foreground">{t('Waiting for a reviewer.')}</p>
				{/if}
			</Stack>
		</Scroll>
	{/if}
{/snippet}

{#snippet logs()}
	<Scroll name={t('Logs')} class="h-full">
		<Stack gap="lg" class="p-4 sm:p-6">
			{#if request !== null && request.diagnostics !== undefined}
				<div class="overflow-hidden rounded-md border border-border/70"><DiagnosisPane diagnostics={request.diagnostics} onopen={onopen} {t} /></div>
			{/if}
			<BuildLog lines={request === null ? view.log : request.log} {t} />
		</Stack>
	</Scroll>
{/snippet}

<Stack gap="none" fill class="min-h-0">
	<Stack gap="sm" shrink={false} class="border-b border-border/60 px-4 py-3 sm:px-6">
		{#if request === null}
			<Cluster align="start" gap="sm">
				<Stack gap="xs" grow class="min-w-0">
					<Cluster gap="xs">
						<h2 class="text-sm font-semibold text-foreground">{t('My draft')}</h2>
						{@render pill(`${view.changes.length} ${t('changed files')}`)}
						{#if (view.behind ?? 0) > 0}{@render pill(`${view.behind} ${t('behind live')}`)}{/if}
					</Cluster>
					<p class="font-mono text-micro text-muted-foreground">
						{#if view.branch !== undefined}{view.branch} · {/if}{t('Head')} {short(view.commit)}{#if view.base !== undefined} · {t('base')} {short(view.base)}{/if}
					</p>
				</Stack>
				{#if target === 'workbench' && view.mergeRequests !== undefined}
					<Button size="sm" variant="outline" disabled={busy || view.changes.length === 0} onclick={onopenmr}>
						<Icon name="lucide:git-pull-request" class="size-3.5" />{t('Open merge request')}
					</Button>
				{/if}
			</Cluster>
			{#if target === 'workbench'}{@render previewControls(view.previewOf ?? null, view.preview)}{/if}
		{:else}
			{@const m = request}
			<Cluster align="start" gap="sm">
				<Stack gap="xs" grow class="min-w-0">
					<Cluster gap="xs">
						<h2 class="text-sm font-semibold text-foreground">!{m.id} {m.title}</h2>
						{@render pill(t(FRESH[reviewFreshness(m)]))}
					</Cluster>
					<Cluster as="ol" gap="xs" aria-label={t('Progress')}>
						{#each RAIL as [stage, title] (stage)}
							<li class="rounded-full px-2 py-0.5 text-micro {m.state === stage ? 'bg-primary/10 font-semibold text-foreground' : reached(m, stage) ? 'text-foreground' : 'text-muted-foreground'}">{t(title)}</li>
						{/each}
						{#if m.state === 'closed'}<li class="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">{t('Closed')}</li>{/if}
					</Cluster>
					<p class="font-mono text-micro text-muted-foreground">
						{#if m.branch !== undefined}{m.branch} · {/if}{short(m.base)}…{short(m.head)}{#if m.behind > 0} · {m.behind} {t('behind live')}{/if}
					</p>
					<p class="text-micro text-muted-foreground">
						{t('by')} {m.openedBy} · {t('next')}: {t(OWNER[reviewNextOwner(m)])}{#if m.readyAt !== null && reviewFreshness(m) !== 'terminal'} · {t('in review')} {reviewAge(m.readyAt, Date.now())}{/if}
					</p>
				</Stack>
				{#if open && mine(m)}
					<Cluster gap="xs" shrink={false}>
						{#if target !== m.id}<Button size="sm" disabled={busy} onclick={() => onswitch(m.id)}>{t('Edit')}</Button>{/if}
						{#if m.state === 'draft'}<Button size="sm" variant="outline" disabled={busy} onclick={() => void run({ op: 'mr.ready', id: m.id })}>{t('Ready for review')}</Button>{/if}
						{#if admin}
							<Button size="sm" disabled={busy || m.decision?.kind !== 'approved' || m.decision.commit !== m.head} onclick={() => void run({ op: 'mr.merge', id: m.id })}>
								<Icon name="lucide:git-merge" class="size-3.5" />{t('Merge')}
							</Button>
						{/if}
						<Button size="sm" variant="ghost" disabled={busy} onclick={() => { if (confirm(t('Close this merge request?'))) void run({ op: 'mr.close', id: m.id }); }}>{t('Close')}</Button>
					</Cluster>
				{/if}
			</Cluster>
			{#if m.preview !== null && !(target === m.id && open)}
				<p class="text-micro text-muted-foreground">{t('Preview')} <a class="text-primary hover:underline" href={m.preview.url} target="_blank" rel="noreferrer">{t(m.preview.live ? 'on live data' : 'on sample data')}</a>
					{#if m.preview.stale} · <span class="text-amber-700 dark:text-amber-300">{t('stale: built from')} <code class="font-mono">{short(m.preview.commit)}</code></span>{/if}</p>
			{/if}
			{#if target === m.id && open}{@render previewControls(m.preview, m.preview?.url ?? null)}{/if}
		{/if}
	</Stack>
	<Tabs value={views.some((v) => v.name === sub) ? sub : 'files'} onValueChange={(v) => (sub = v)} orientation="horizontal" class={PANE} tabs={views} />
</Stack>
