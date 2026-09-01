<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import type { WorkbenchView } from '#lib/client/ui/studio/studio-state.js';
	import { presentWorkbenchStatus } from '#lib/client/ui/studio/workbench-status-presentation.js';

	let {
		hostStatus,
		busy = false,
		view = 'manifest',
		previewReady = false,
		draftCount = 0,
		currentCommit,
		previewExpiresAt,
		previewExpired = false,
		buildFailed = false,
		updateRequired = false,
		updateDisabled = false,
		updateReason,
		previewDisabled = true,
		previewReason,
		reviewRequested = false,
		reviewDisabled = true,
		reviewReason,
		onview,
		onpreview,
		onopenpreview,
		onreview,
		onopenreview,
		onrebase,
		onactivity
	}: {
		hostStatus: string;
		busy?: boolean;
		view?: WorkbenchView;
		previewReady?: boolean;
		draftCount?: number;
		currentCommit?: string | undefined;
		previewExpiresAt?: number | undefined;
		previewExpired?: boolean;
		buildFailed?: boolean;
		updateRequired?: boolean;
		updateDisabled?: boolean;
		updateReason: string;
		previewDisabled?: boolean;
		previewReason: string;
		reviewRequested?: boolean;
		reviewDisabled?: boolean;
		reviewReason: string;
		onview?: ((next: WorkbenchView) => void) | undefined;
		onpreview?: (() => void) | undefined;
		onopenpreview?: (() => void) | undefined;
		onreview?: (() => void) | undefined;
		onopenreview?: (() => void) | undefined;
		onrebase?: (() => void) | undefined;
		onactivity?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const toolbarStatus = $derived(presentWorkbenchStatus({ hostStatus, busy, previewReady }));
	const supportingState = $derived.by(() => {
		if (draftCount > 0) return t('bolt.studio.unsavedFiles', { count: draftCount });
		if (hostStatus.startsWith('Migration ready')) return t('bolt.studio.reviewMigration');
		if (previewExpired) return t('bolt.studio.previewExpired');
		if (buildFailed) return t('bolt.studio.lastPreviewFailed');
		if (previewReady && previewExpiresAt !== undefined) {
			return t('bolt.studio.previewUntil', {
				time: new Intl.DateTimeFormat(undefined, {
					hour: 'numeric',
					minute: '2-digit'
				}).format(previewExpiresAt)
			});
		}
		if (currentCommit !== undefined)
			return t('bolt.studio.commitValue', { commit: currentCommit.slice(0, 12) });
		return undefined;
	});
</script>

<Inline shrink={false} class="h-10 border-b border-border/60 sm:h-9">
	<Scroll name={t('bolt.studio.workbench')} axis="x" layout="inline" gap="xs" grow class="min-w-0">
		<Tabs
			value={view}
			onValueChange={(next) => {
				if (next === 'manifest' || next === 'editor') onview?.(next);
			}}
			showContent={false}
			animate={false}
			variant="underline"
			listClass="mx-1"
			config={[
				{ name: 'manifest', label: t('bolt.studio.manifest'), icon: 'lucide:braces', content: '' },
				{ name: 'editor', label: t('bolt.studio.source'), icon: 'lucide:code-2', content: '' }
			] satisfies TabConfig[]}
		/>
		{#if toolbarStatus}
			<Badge
				variant={toolbarStatus.variant}
				class="h-5 max-w-48 shrink-0 gap-1 px-2 py-0 text-micro"
				data-testid={toolbarStatus.testId}
				aria-busy={toolbarStatus.loading}
				title={toolbarStatus.detailKey === undefined
					? toolbarStatus.detail
					: t(toolbarStatus.detailKey)}
			>
				<Icon
					icon={toolbarStatus.icon}
					class={toolbarStatus.loading ? 'size-3 shrink-0 animate-spin' : 'size-3 shrink-0'}
					aria-hidden="true"
				/>
				<span class="truncate">{t(toolbarStatus.labelKey)}</span>
			</Badge>
		{/if}
		{#if supportingState !== undefined}
			<span
				class="max-w-44 shrink-0 truncate text-micro text-muted-foreground"
				title={supportingState}
				data-testid="studio-workbench-supporting-state"
			>
				{supportingState}
			</span>
		{/if}
	</Scroll>

	<Inline gap="xs" shrink={false}>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="h-8 gap-1 px-2 text-xs sm:h-7 sm:text-micro"
			aria-label={t('bolt.studio.openActivity')}
			onclick={() => onactivity?.()}
		>
			<Icon icon="lucide:activity" class="size-3.5" />
			<span class="hidden sm:inline">{t('bolt.studio.activity')}</span>
		</Button>
		{#if updateRequired}
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={updateDisabled}
				disabledMessage={updateReason}
				data-testid="studio-rebase"
				onclick={() => onrebase?.()}
			>
				<Icon icon="lucide:git-rebase" class="size-3.5" />
				{t('bolt.studio.rebase')}
			</Button>
		{:else if previewReady}
			<Button
				type="button"
				variant="outline"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={previewDisabled}
				disabledMessage={previewReason}
				data-testid="studio-preview"
				onclick={() => onopenpreview?.()}
			>
				<Icon icon="lucide:external-link" class="size-3.5" />
				{t('bolt.studio.openPreview')}
			</Button>
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={!reviewRequested && reviewDisabled}
				disabledMessage={reviewReason}
				data-testid={reviewRequested ? 'studio-open-review' : 'studio-request-review'}
				onclick={() => (reviewRequested ? onopenreview?.() : onreview?.())}
			>
				<Icon icon="lucide:git-pull-request" class="size-3.5" />
				{t(reviewRequested ? 'bolt.studio.openReview' : 'bolt.studio.requestReview')}
			</Button>
		{:else}
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={previewDisabled}
				disabledMessage={previewReason}
				data-testid="studio-preview"
				onclick={() => onpreview?.()}
			>
				<Icon icon="lucide:scan-eye" class="size-3.5" />
				{t('bolt.studio.preview')}
			</Button>
		{/if}
	</Inline>
</Inline>
