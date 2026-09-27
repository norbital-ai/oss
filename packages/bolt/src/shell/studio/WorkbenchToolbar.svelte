<!--
	The workbench's toolbar (staging's workbench-toolbar): what the workbench is on (the viewer's draft or a merge request),
	the diff baseline, how far behind live it is, a status badge (working, the running phase, a failure, conflicts) and the
	unsaved count, scrolling sideways on a phone; then the actions, the primary one last (Update from Live when behind, else
	Publish for an administrator). Secondary actions collapse to icons on a phone.
-->
<script lang="ts">
	import { Badge, Button, Combobox, Icon, type BadgeVariant } from '@norbital-ai/ui';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { PHASES, type PhaseState, type StudioMergeRequest, type StudioPhase, type StudioView } from '../studio.ts';

	let { view, targets, admin, busy, drafts, phases, error, previewing, onswitch, onnew, onsave, onpreview, onrebase, onopenmr, onpublish, onreview, t }: {
		view: StudioView; targets: readonly StudioMergeRequest[]; admin: boolean; busy: boolean; drafts: number;
		phases: { readonly [p in StudioPhase]?: PhaseState }; error: string | null; previewing: boolean;
		onswitch: (target: string) => void; onnew: () => void; onsave: () => void; onpreview: () => void; onrebase: () => void;
		onopenmr: () => void; onpublish: () => void; onreview: () => void; t: (key: string) => string;
	} = $props();

	const target = $derived(view.target ?? 'workbench');
	const behind = $derived(view.behind ?? 0);
	const STAGE = { draft: 'Draft', ready: 'Ready for review', merged: 'Merged', closed: 'Closed' } as const;
	const options = $derived([{ value: 'workbench', label: `${t('My draft')}${view.branch === undefined ? '' : ` · ${view.branch}`}` },
		...targets.map((m) => ({ value: m.id, label: `!${m.id} ${m.title} · ${t(STAGE[m.state])}` }))]);
	const phaseTitle = (p: StudioPhase) => t(p === 'diagnose' ? 'Diagnose' : p === 'preview' ? 'Preview' : 'Merge');
	/** The badge staging's `presentWorkbenchStatus` chose: working, a failure, conflicts to resolve; nothing when idle. */
	const status = $derived.by((): { label: string; detail?: string; icon: string; variant: BadgeVariant; loading?: true } | null => {
		const running = PHASES.find((p) => phases[p] === 'running');
		const failed = PHASES.find((p) => phases[p] === 'failed');
		if (busy || running !== undefined) return { label: running === undefined ? t('Working…') : `${phaseTitle(running)}…`, icon: 'lucide:loader-2', variant: 'outline', loading: true };
		if (error !== null) return { label: t('Action failed'), detail: error, icon: 'lucide:circle-alert', variant: 'destructive' };
		if (failed !== undefined) return { label: `${phaseTitle(failed)} · ${t('failed')}`, icon: 'lucide:circle-alert', variant: 'destructive' };
		if ((view.conflicts?.length ?? 0) > 0) return { label: t('Action required'), detail: `${t('Resolve the conflict markers in')} ${view.conflicts?.join(', ')}`, icon: 'lucide:triangle-alert', variant: 'warning' };
		if (phases.preview === 'done' || phases.merge === 'done') return { label: t('Updated'), icon: 'lucide:circle-check', variant: 'success' };
		return null;
	});
	const ACTION = 'h-8 px-2 text-xs sm:h-7 sm:text-micro';
</script>

{#snippet action(icon: string, label: string, onclick: () => void, disabled: boolean, pressed?: boolean)}
	<Button variant="ghost" size="sm" class={ACTION} {disabled} aria-label={label} title={label} aria-pressed={pressed} {onclick}>
		<Icon name={icon} class="size-3.5" /><span class="hidden sm:inline">{label}</span>
	</Button>
{/snippet}

<Inline gap="xs" shrink={false} class="h-10 min-w-0 border-b border-border/60 sm:h-9">
	<Scroll name={t('Workbench')} axis="x" layout="inline" gap="xs" grow class="min-w-0 items-center">
		{#if view.mergeRequests !== undefined && view.mergeRequests.length > 0}
			<div class="w-64 max-w-[min(16rem,60vw)] shrink-0">
				<Combobox variant="ghost" size="sm" aria-label={t('Target')} {options} value={target} disabled={busy} onChange={(next) => { if (next !== null && next !== target) onswitch(next); }} />
			</div>
		{:else if view.branch !== undefined}
			<code class="shrink-0 font-mono text-micro text-muted-foreground">{view.branch}</code>
		{/if}
		<span class="shrink-0 text-micro text-muted-foreground" title={view.commit}>
			{t(target === 'workbench' ? 'against Live' : 'against MR head')} · <code class="font-mono">{view.commit.slice(0, 8)}</code>
		</span>
		{#if behind > 0}
			<Badge variant="warning" class="h-5 max-w-48 shrink-0 px-2 py-0 text-micro">{behind} {t('behind live')}</Badge>
		{/if}
		{#if status !== null}
			<Badge variant={status.variant} class="h-5 max-w-48 shrink-0 gap-1 px-2 py-0 text-micro" title={status.detail} aria-busy={status.loading}>
				<Icon name={status.icon} class="size-3 shrink-0 {status.loading ? 'animate-spin' : ''}" /><span class="truncate">{status.label}</span>
			</Badge>
		{/if}
		{#if drafts > 0}
			<span class="max-w-44 shrink-0 truncate text-micro text-muted-foreground">{drafts} {t('unsaved')}</span>
		{/if}
	</Scroll>
	<Inline gap="xs" shrink={false}>
		{@render action('lucide:file-plus', t('New file'), onnew, busy)}
		{@render action('lucide:save', t('Save'), onsave, busy || drafts === 0)}
		{@render action('lucide:scan-eye', t('Preview'), onpreview, busy, previewing)}
		{#if target === 'workbench'}
			{#if view.mergeRequests !== undefined}{@render action('lucide:git-pull-request', t('Open merge request'), onopenmr, busy || view.changes.length === 0)}{/if}
		{:else}
			{@render action('lucide:git-pull-request', t('Review'), onreview, busy)}
		{/if}
		{#if behind > 0}
			<Button size="sm" class="{ACTION} font-semibold" disabled={busy} onclick={onrebase}>
				<Icon name="lucide:arrow-up-from-line" class="size-3.5" />{t('Update from Live')}
			</Button>
		{:else if admin && target === 'workbench'}
			<Button size="sm" class="{ACTION} font-semibold" disabled={busy} onclick={onpublish}>
				<Icon name="lucide:upload" class="size-3.5" />{t('Publish')}
			</Button>
		{/if}
	</Inline>
</Inline>
