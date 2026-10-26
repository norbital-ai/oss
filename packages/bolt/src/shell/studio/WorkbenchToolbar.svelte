<!--
	The workbench's toolbar : the change the viewer works on (or Live, with no change open), how far behind live it is,
	a status badge (working, the running phase, a failure, conflicts) and the unsaved count; then Save, Preview and the
	primary action last (Merge for an administrator with a change open, else New change). Everything else — a new file,
	the branch and the commit it is on — is behind "…".
-->
<script lang="ts">
	import { Badge, Button, Icon, Popover, type BadgeVariant } from '@norbital-ai/ui';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { PHASES, type PhaseState, type StudioPhase, type StudioView } from './model.ts';

	let {
		view,
		admin,
		busy,
		drafts,
		phases,
		error,
		previewing,
		onnew,
		onsave,
		onpreview,
		onopen,
		onmerge,
		onreview,
		oninstall,
		t
	}: {
		view: StudioView;
		admin: boolean;
		busy: boolean;
		drafts: number;
		phases: { readonly [p in StudioPhase]?: PhaseState };
		error: string | null;
		previewing: boolean;
		onnew: () => void;
		onsave: () => void;
		onpreview: () => void;
		onopen: () => void;
		onmerge: () => void;
		onreview: () => void;
		oninstall: () => void;
		t: (key: string) => string;
	} = $props();

	const change = $derived(view.changeSets?.find((c) => c.id === view.change));
	const behind = $derived(view.behind ?? 0);
	const merging = $derived(change?.merge?.state === 'running');
	const phaseTitle = (p: StudioPhase) =>
		t(
			p === 'diagnose'
				? 'Building'
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
			if (busy || running !== undefined || merging)
				return {
					label:
						running === undefined
							? t(merging ? 'Merging…' : 'Working…')
							: `${phaseTitle(running)}…`,
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
			if (change?.merge?.state === 'failed')
				return {
					label: t('Merge failed'),
					...(change.merge.error === undefined ? {} : { detail: change.merge.error }),
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
		<span
			class="max-w-64 shrink-0 truncate text-xs font-medium text-foreground"
			data-change={change?.id}
			>{change === undefined ? t('Live') : `!${change.id} ${change.title}`}</span
		>
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
		{#if change !== undefined}
			{@render action('lucide:scan-eye', t('Preview'), onpreview, busy || drafts > 0, previewing)}
			{@render action('lucide:git-compare', t('Review'), onreview, busy)}
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
				{#if change !== undefined}
					<Button
						size="sm"
						variant="ghost"
						class="justify-start"
						disabled={busy}
						onclick={pick(onopen)}
					>
						<Icon name="lucide:git-branch-plus" class="size-3.5" />{t('New change')}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						class="justify-start"
						disabled={busy}
						onclick={pick(oninstall)}
					>
						<Icon name="lucide:package-plus" class="size-3.5" />{t('Install package')}
					</Button>
				{/if}
				<p class="border-t border-border/60 px-2 pt-1.5 pb-1 text-micro text-muted-foreground">
					{#if view.branch !== undefined}<code class="block truncate font-mono">{view.branch}</code
						>{/if}
					{t(change === undefined ? 'Live' : 'against Live')} ·
					<code class="font-mono">{view.commit.slice(0, 8)}</code>
				</p>
			</Popover.Content>
		</Popover.Root>
		{#if change === undefined}
			<Button size="sm" class="{ACTION} font-semibold" disabled={busy} onclick={onopen}>
				<Icon name="lucide:git-branch-plus" class="size-3.5" />{t('New change')}
			</Button>
		{:else if admin}
			<Button
				size="sm"
				class="{ACTION} font-semibold"
				disabled={busy || merging || view.changes.length === 0}
				onclick={onmerge}
			>
				<Icon name="lucide:git-merge" class="size-3.5" />{t('Merge')}
			</Button>
		{/if}
	</Inline>
</Inline>
