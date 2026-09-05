<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import {
		lifecycleRailCurrent,
		lifecycleRailMessageKey,
		type MergeRequest,
		type WorkbenchDiffBaselineKey
	} from '#lib/client/ui/studio/studio-state.js';
	import { presentWorkbenchStatus } from '#lib/client/ui/studio/workbench-status-presentation.js';

	let {
		hostStatus,
		busy = false,
		liveStatus,
		tracking = 'live',
		requests = [],
		principal = '',
		newCommits = 0,
		baselineKey,
		draftCount = 0,
		updateRequired = false,
		updateDisabled = false,
		updateReason,
		publishDisabled = true,
		publishReason,
		onswitch,
		onpublish,
		ondiagnose,
		onupdate
	}: {
		hostStatus: string;
		busy?: boolean;
		liveStatus?: string | undefined;
		tracking?: 'live' | string;
		requests?: ReadonlyArray<MergeRequest>;
		principal?: string;
		newCommits?: number;
		baselineKey: WorkbenchDiffBaselineKey;
		draftCount?: number;
		updateRequired?: boolean;
		updateDisabled?: boolean;
		updateReason: string;
		publishDisabled?: boolean;
		publishReason: string;
		onswitch?: ((to: 'live' | string) => void) | undefined;
		onpublish?: (() => void) | undefined;
		ondiagnose?: (() => void) | undefined;
		onupdate?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const toolbarStatus = $derived(
		presentWorkbenchStatus({
			hostStatus,
			busy,
			previewReady: false,
			...(liveStatus === undefined ? {} : { liveStatus })
		})
	);
	const supportingState = $derived.by(() => {
		if (draftCount > 0) return t('bolt.studio.unsavedFiles', { count: draftCount });
		if (hostStatus.startsWith('Migration ready')) return t('bolt.studio.reviewMigration');
		return undefined;
	});
	const switcherRequests = $derived.by(() => {
		const open = requests.filter(
			(request) => request.state === 'draft' || request.state === 'ready'
		);
		if (tracking === 'live' || open.some((request) => request.id === tracking)) return open;
		const current = requests.find((request) => request.id === tracking);
		return current === undefined ? open : [current, ...open];
	});

	const requestOptionLabel = (request: MergeRequest): string => {
		const title = request.title.trim() === '' ? request.id : request.title;
		const stage = lifecycleRailCurrent(request.state);
		const stageLabel =
			stage === 'closed' ? t('bolt.studio.reviewStatus.closed') : t(lifecycleRailMessageKey(stage));
		const people = request.trackedBy
			.map((id) => (id === principal ? t('bolt.studio.you') : id))
			.join(', ');
		return people === '' ? `${title} · ${stageLabel}` : `${title} · ${stageLabel} · ${people}`;
	};
	const switcherOptions = $derived([
		{
			value: 'live',
			label: `${t('bolt.studio.localBase')} · ${t('bolt.studio.localBaseOnLive')}`
		},
		...switcherRequests.map((request) => ({
			value: request.id,
			label: requestOptionLabel(request)
		}))
	]);
</script>

<Inline shrink={false} class="h-10 border-b border-border/60 sm:h-9">
	<Scroll name={t('bolt.studio.workbench')} axis="x" layout="inline" gap="xs" grow class="min-w-0">
		<div
			data-testid="studio-mr-switcher"
			class="w-64 max-w-[min(16rem,80vw)] shrink-0"
		>
			<Combobox
				options={switcherOptions}
				value={tracking}
				ariaLabel={t('bolt.studio.switcherAria')}
				searchPlaceholder={t('bolt.studio.switcherAria')}
				emptyPlaceholder={t('bolt.studio.switcherAria')}
				allowClear={false}
				preserveOptionOrder={true}
				scrollToSelection={true}
				sameWidth={true}
				align="start"
				class="w-full"
				triggerClass="h-7 rounded-sm border-border/60 px-1.5 text-xs"
				onValueChange={(next) => {
					if (typeof next === 'string') onswitch?.(next);
				}}
			/>
		</div>
		<span class="shrink-0 text-micro text-muted-foreground" data-testid="studio-diff-baseline">
			{t(baselineKey)}
		</span>
		{#if newCommits > 0}
			<Badge
				variant="warning"
				class="h-5 max-w-48 shrink-0 gap-1 px-2 py-0 text-micro"
				data-testid="studio-new-commits"
			>
				{t('bolt.studio.newCommits', { count: newCommits })}
			</Badge>
		{/if}
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
					class="{toolbarStatus.loading ? 'size-3 shrink-0 animate-spin' : 'size-3 shrink-0'}"
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
			disabled={busy}
			data-testid="studio-diagnose"
			onclick={() => ondiagnose?.()}
		>
			<Icon icon="lucide:stethoscope" class="size-3.5" />
			{t('bolt.studio.diagnose')}
		</Button>
		{#if updateRequired || newCommits > 0}
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={updateDisabled}
				disabledMessage={updateReason}
				data-testid="studio-update"
				onclick={() => onupdate?.()}
			>
				<Icon icon="lucide:arrow-up-from-line" class="size-3.5" />
				{t(updateRequired ? 'bolt.studio.updateFromLive' : 'bolt.studio.update')}
			</Button>
		{:else}
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={publishDisabled}
				disabledMessage={publishReason}
				data-testid="studio-publish"
				onclick={() => onpublish?.()}
			>
				<Icon icon="lucide:upload" class="size-3.5" />
				{t('bolt.studio.publish')}
			</Button>
		{/if}
	</Inline>
</Inline>
