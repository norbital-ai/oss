<!--
	Studio's toolbar above the navigator and pane: the change the viewer works on (or Live, with no change open) and the
	unsaved count; then Save, Review, unscheduling a scheduled merge, closing the change, and the primary action last
	(Merge for an administrator with a change open, else New change). New files are + buttons in the source tree. The
	change's behind/status badges are in the app header. A change's preview is its Preview tab on Changes: selecting it
	builds the latest commit, never a draft.
-->
<script lang="ts">
	import { Button, Icon } from '@norbital-ai/ui';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import type { Snippet } from 'svelte';
	import type { StudioView } from './model.ts';

	let {
		view,
		navigator,
		admin,
		busy,
		drafts,
		onsave,
		onopen,
		onmerge,
		onclose,
		onunschedule,
		onreview,
		t
	}: {
		view: StudioView;
		navigator: Snippet;
		admin: boolean;
		busy: boolean;
		drafts: number;
		onsave: () => void;
		onopen: () => void;
		onmerge: () => void;
		/** Close the change the viewer works on: its preview and its copy of the data go; its edits stay in history. */
		onclose: () => void;
		onunschedule: () => void;
		onreview: () => void;
		t: (key: string) => string;
	} = $props();

	const change = $derived(view.changeSets?.find((c) => c.id === view.change));
	const label = $derived(
		change === undefined ? t('Live') : `${t('Change')} ${change.id} · ${change.title}`
	);
	const merging = $derived(change?.merge?.state === 'running');
	const scheduled = $derived(
		change?.merge?.state === 'scheduled' && change.merge.runAt !== undefined
			? new Date(change.merge.runAt).toLocaleString()
			: null
	);
	const ACTION = 'px-2 text-xs';
</script>

{#snippet action(icon: string, label: string, onclick: () => void, disabled: boolean)}
	<Button variant="ghost" class={ACTION} {disabled} aria-label={label} title={label} {onclick}>
		<Icon name={icon} class="size-3.5" /><span class="hidden sm:inline">{label}</span>
	</Button>
{/snippet}

{#snippet iconAction(icon: string, label: string, onclick: () => void, disabled: boolean)}
	<Button
		variant="ghost"
		size="icon"
		class="shrink-0"
		{disabled}
		aria-label={label}
		title={label}
		{onclick}
	>
		<Icon name={icon} class="size-4" />
	</Button>
{/snippet}

<Inline gap="sm" class="min-h-10 min-w-0 border-b border-border/60 px-3 py-1">
	{@render navigator()}
	<Scroll
		name={t('Studio')}
		axis="x"
		layout="inline"
		gap="xs"
		size="fill"
		class="min-w-0 items-center"
	>
		<span
			class="max-w-64 shrink-0 truncate text-xs font-medium text-foreground"
			title={label}
			data-change={change?.id}>{label}</span
		>
		{#if drafts > 0}
			<span class="max-w-44 shrink-0 truncate text-micro text-muted-foreground"
				>{drafts} {t('unsaved')}</span
			>
		{/if}
	</Scroll>
	<Inline gap="xs">
		{@render action('lucide:save', t('Save'), onsave, busy || drafts === 0)}
		{#if change !== undefined}
			{@render action('lucide:git-compare', t('Review'), onreview, busy)}
			{#if admin}
				{#if scheduled !== null}
					{@render iconAction(
						'lucide:calendar-x',
						t('Unschedule merge'),
						onunschedule,
						busy || merging
					)}
				{/if}
				{@render iconAction('lucide:x', t('Close change'), onclose, busy || merging)}
			{/if}
			{#if admin}
				<Button
					class="{ACTION} font-semibold"
					disabled={busy || merging || view.changes.length === 0}
					onclick={onmerge}
				>
					<Icon name="lucide:git-merge" class="size-3.5" />{t('Merge')}
				</Button>
			{/if}
		{:else}
			<Button class="{ACTION} font-semibold" disabled={busy} onclick={onopen}>
				<Icon name="lucide:git-branch-plus" class="size-3.5" />{t('New change')}
			</Button>
		{/if}
	</Inline>
</Inline>
