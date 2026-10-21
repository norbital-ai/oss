<!--
	The workbench's toolbar : what the workbench is on (the viewer's draft or a merge request), how far behind live it is,
	a status badge (working, the running phase, a failure, conflicts) and the unsaved count; then Save, Preview and the
	primary action last (Update from Live when behind, else Publish for an administrator). Everything else — a new file, a
	merge request, the branch and the commit it is based on — is behind "…".
-->
<script lang="ts">
	import { Badge, Button, Combobox, Icon, Popover, type BadgeVariant } from '@norbital-ai/ui';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import {
		PHASES,
		type PhaseState,
		type StudioMergeRequest,
		type StudioPhase,
		type StudioView
	} from './model.ts';

	let {
		view,
		targets,
		admin,
		busy,
		drafts,
		phases,
		error,
		previewing,
		onswitch,
		onnew,
		onsave,
		onpreview,
		onrebase,
		onopenmr,
		onpublish,
		onreview,
		t
	}: {
		view: StudioView;
		targets: readonly StudioMergeRequest[];
		admin: boolean;
		busy: boolean;
		drafts: number;
		phases: { readonly [p in StudioPhase]?: PhaseState };
		error: string | null;
		previewing: boolean;
		onswitch: (target: string) => void;
		onnew: () => void;
		onsave: () => void;
		onpreview: () => void;
		onrebase: () => void;
		onopenmr: () => void;
		onpublish: () => void;
		onreview: () => void;
		t: (key: string) => string;
	} = $props();

	const target = $derived(view.target ?? 'workbench');
	const behind = $derived(view.behind ?? 0);
	const STAGE = {
		draft: 'Draft',
		ready: 'Ready for review',
		merged: 'Merged',
		closed: 'Closed'
	} as const;
	const options = $derived([
		{
			value: 'workbench',
			label: `${t('My draft')}${view.branch === undefined ? '' : ` · ${view.branch}`}`
		},
		...targets.map((m) => ({ value: m.id, label: `!${m.id} ${m.title} · ${t(STAGE[m.state])}` }))
	]);
	const phaseTitle = (p: StudioPhase) =>
		t(
			p === 'diagnose'
				? 'Diagnose'
				: p === 'copy'
					? 'Copying data'
					: p === 'preview'
						? 'Preview'
						: 'Merge'
		);
	/** The workbench status badge: working, a failure, conflicts to resolve; nothing when idle. */
	const status = $derived.by(
		(): {
			label: string;
			detail?: string;
			icon: string;
			variant: BadgeVariant;
			loading?: true;
		} | null => {
			const running = PHASES.find((p) => phases[p] === 'running');
			const failed = PHASES.find((p) => phases[p] === 'failed');
			if (busy || running !== undefined)
				return {
					label: running === undefined ? t('Working…') : `${phaseTitle(running)}…`,
					icon: 'lucide:loader-2',
					variant: 'outline',
					loading: true
				};
			if (error !== null)
				return {
					label: t('Action failed'),
					detail: error,
					icon: 'lucide:circle-alert',
					variant: 'destructive'
				};
			if (failed !== undefined)
				return {
					label: `${phaseTitle(failed)} · ${t('failed')}`,
					icon: 'lucide:circle-alert',
					variant: 'destructive'
				};
			if ((view.conflicts?.length ?? 0) > 0)
				return {
					label: t('Action required'),
					detail: `${t('Resolve the conflict markers in')} ${view.conflicts?.join(', ')}`,
					icon: 'lucide:triangle-alert',
					variant: 'warning'
				};
			if (phases.preview === 'done' || phases.merge === 'done')
				return { label: t('Updated'), icon: 'lucide:circle-check', variant: 'success' };
			return null;
		}
	);
	const ACTION = 'px-2 text-xs sm:text-micro';
	let more = $state(false);
	const pick = (run: () => void) => () => {
		more = false;
		run();
	};
</script>

{#snippet action(
	icon: string,
	label: string,
	onclick: () => void,
	disabled: boolean,
	pressed?: boolean
)}
	<Button
		variant="ghost"
		size="sm"
		class={ACTION}
		{disabled}
		aria-label={label}
		title={label}
		aria-pressed={pressed}
		{onclick}
	>
		<Icon name={icon} class="size-3.5" /><span class="hidden sm:inline">{label}</span>
	</Button>
{/snippet}

<Inline gap="xs" shrink={false} class="h-10 min-w-0 border-b border-border/60 sm:h-9">
	<Scroll name={t('Workbench')} axis="x" layout="inline" gap="xs" grow class="min-w-0 items-center">
		{#if view.mergeRequests !== undefined && view.mergeRequests.length > 0}
			<div class="w-64 max-w-[min(16rem,60vw)] shrink-0">
				<Combobox
					variant="ghost"
					size="sm"
					aria-label={t('Target')}
					{options}
					value={target}
					disabled={busy}
					onChange={(next) => {
						if (next !== null && next !== target) onswitch(next);
					}}
				/>
			</div>
		{:else}
			<span class="shrink-0 text-xs font-medium text-foreground">{t('My draft')}</span>
		{/if}
		{#if behind > 0}
			<Badge variant="warning" class="h-5 max-w-48 shrink-0 px-2 py-0 text-micro"
				>{behind} {t('behind live')}</Badge
			>
		{/if}
		{#if status !== null}
			<Badge
				variant={status.variant}
				class="h-5 max-w-48 shrink-0 gap-1 px-2 py-0 text-micro"
				title={status.detail}
				aria-busy={status.loading}
			>
				<Icon
					name={status.icon}
					class="size-3 shrink-0 {status.loading ? 'animate-spin' : ''}"
				/><span class="truncate">{status.label}</span>
			</Badge>
		{/if}
		{#if drafts > 0}
			<span class="max-w-44 shrink-0 truncate text-micro text-muted-foreground"
				>{drafts} {t('unsaved')}</span
			>
		{/if}
	</Scroll>
	<Inline gap="xs" shrink={false}>
		{@render action('lucide:save', t('Save'), onsave, busy || drafts === 0)}
		{@render action('lucide:scan-eye', t('Preview'), onpreview, busy, previewing)}
		{#if target !== 'workbench'}
			{@render action('lucide:git-pull-request', t('Review'), onreview, busy)}
		{/if}
		<Popover.Root bind:open={more}>
			<Popover.Trigger
				class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-sm:size-10"
				aria-label={t('More')}
				title={t('More')}
			>
				<Icon name="lucide:ellipsis" class="size-4" />
			</Popover.Trigger>
			<Popover.Content align="end" class="grid w-64 gap-0.5 p-1">
				<Button
					size="sm"
					variant="ghost"
					class="justify-start"
					disabled={busy}
					onclick={pick(onnew)}
				>
					<Icon name="lucide:file-plus" class="size-3.5" />{t('New file')}
				</Button>
				{#if target === 'workbench' && view.mergeRequests !== undefined}
					<Button
						size="sm"
						variant="ghost"
						class="justify-start"
						disabled={busy || view.changes.length === 0}
						onclick={pick(onopenmr)}
					>
						<Icon name="lucide:git-pull-request" class="size-3.5" />{t('Open merge request')}
					</Button>
				{/if}
				<p class="border-t border-border/60 px-2 pt-1.5 pb-1 text-micro text-muted-foreground">
					{#if view.branch !== undefined}<code class="block truncate font-mono">{view.branch}</code
						>{/if}
					{t(target === 'workbench' ? 'against Live' : 'against MR head')} ·
					<code class="font-mono">{view.commit.slice(0, 8)}</code>
				</p>
			</Popover.Content>
		</Popover.Root>
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
