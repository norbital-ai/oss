<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Badge } from '@norbital-ai/ui/badge';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		currentRoutedRelease,
		formatMicroSgd,
		reviewStatusMessageKey,
		studioMetrics,
		type HostSnapshot,
		type ReleaseControls,
		type WorkbenchBuildReceipt
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		snapshot,
		receipt,
		hostStatus,
		controls,
		onrollback
	}: {
		snapshot?: HostSnapshot | undefined;
		receipt?: WorkbenchBuildReceipt | undefined;
		hostStatus: string;
		controls?: ReleaseControls | undefined;
		onrollback?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	let buildOpen = $state(false);
	let historyOpen = $state(false);
	let runtimeOpen = $state(false);
	const currentRelease = $derived(currentRoutedRelease(snapshot?.entries ?? []));
	const metrics = $derived(
		studioMetrics({ usage: snapshot?.usage ?? [], source: snapshot?.source })
	);
	const openReview = $derived(
		[...(snapshot?.releaseRequests ?? [])]
			.reverse()
			.find((request) => request.status === 'open' || request.status === 'approving')
	);
	const missingFacilities = $derived(
		(snapshot?.facilities ?? []).filter((facility) => !facility.available)
	);
	const duration = $derived.by(() => {
		if (receipt === undefined) return undefined;
		const milliseconds = Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt);
		return Number.isFinite(milliseconds) && milliseconds >= 0
			? t('bolt.studio.durationSeconds', {
					count: (milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)
				})
			: undefined;
	});
	const usagePeriod = $derived.by(() => {
		const estimate = snapshot?.usageEstimate;
		if (estimate == null) return undefined;
		const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
		return `${dates.format(estimate.periodStartMillis)} – ${dates.format(estimate.periodEndMillis - 1)}`;
	});
	const quantity = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
	const buildOutcomeLabel = (outcome: WorkbenchBuildReceipt['outcome']): string => {
		if (outcome === 'succeeded') return t('bolt.studio.buildOutcome.succeeded');
		if (outcome === 'failed') return t('bolt.studio.buildOutcome.failed');
		return t('bolt.studio.buildOutcome.migrationRequired');
	};
	const buildPhaseLabel = (phase: WorkbenchBuildReceipt['phase']): string => {
		if (phase === 'prepare') return t('bolt.studio.phase.prepare');
		if (phase === 'checks') return t('bolt.studio.phase.checks');
		if (phase === 'publish') return t('bolt.studio.phase.publish');
		if (phase === 'provision') return t('bolt.studio.phase.provision');
		return t('bolt.studio.phase.complete');
	};
	const cacheLabel = (cache: WorkbenchBuildReceipt['cache']): string => {
		if (cache === 'hit') return t('bolt.studio.cache.hit');
		if (cache === 'miss') return t('bolt.studio.cache.miss');
		return t('bolt.studio.cache.notReached');
	};
</script>

{#snippet disclosureButton(label: string, open: boolean, controlsId: string, onclick: () => void)}
	<Button
		type="button"
		variant="ghost"
		class="h-auto w-full justify-between px-0 py-0 text-xs font-semibold"
		aria-expanded={open}
		aria-controls={controlsId}
		{onclick}
	>
		<span>{label}</span>
		<Icon icon={open ? 'lucide:chevron-up' : 'lucide:chevron-down'} class="size-3.5" />
	</Button>
{/snippet}

<Scroll name={t('bolt.studio.activity')} class="h-full px-4 py-4 sm:px-5">
	<Stack gap="lg">
		{#if hostStatus.startsWith('Failed:') || hostStatus.startsWith('Unavailable:')}
			<p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
				{hostStatus}
			</p>
		{/if}
		<Stack gap="sm">
			<h3 class="text-overline">{t('bolt.studio.latest')}</h3>
			<ol class="divide-y divide-border/50 border-y border-border/50">
				{#if receipt !== undefined}
					<li class="py-2">
						<Inline gap="sm" align="start">
							<Icon
								icon={receipt.outcome === 'succeeded'
									? 'lucide:circle-check'
									: 'lucide:circle-alert'}
								class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
							/>
							<Stack gap="xs" grow class="min-w-0">
								<p class="text-xs font-medium text-foreground">
									{t('bolt.studio.previewOutcome', { outcome: buildOutcomeLabel(receipt.outcome) })}
								</p>
								<p class="text-micro text-muted-foreground">{receipt.summary}</p>
							</Stack>
						</Inline>
					</li>
				{/if}
				{#if snapshot?.preview !== null && snapshot?.preview !== undefined}
					<li class="py-2">
						<Inline gap="sm" align="start">
							<Icon icon="lucide:scan-eye" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<Stack gap="xs">
								<p class="text-xs font-medium text-foreground">{t('bolt.studio.previewReady')}</p>
								<p class="font-mono text-micro text-muted-foreground">
									{snapshot.preview.commit.slice(0, 12)}
								</p>
							</Stack>
						</Inline>
					</li>
				{/if}
				{#if openReview !== undefined}
					<li class="py-2">
						<Inline gap="sm" align="start">
							<Icon
								icon="lucide:git-pull-request"
								class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
							/>
							<Stack gap="xs">
								<p class="text-xs font-medium text-foreground">
									{t('bolt.studio.reviewOutcome', {
										status: t(reviewStatusMessageKey(openReview.status))
									})}
								</p>
								<p class="text-micro text-muted-foreground">
									{openReview.authorId} · {openReview.commit.slice(0, 12)}
								</p>
							</Stack>
						</Inline>
					</li>
				{/if}
				{#if receipt === undefined && snapshot?.preview == null && openReview === undefined}
					<li class="py-2 text-meta">{hostStatus}</li>
				{/if}
			</ol>
		</Stack>

		{#if receipt !== undefined}
			<Stack as="section" gap="sm">
				{@render disclosureButton(
					t('bolt.studio.buildDetails'),
					buildOpen,
					'activity-build-details',
					() => (buildOpen = !buildOpen)
				)}
				{#if buildOpen}
					<Stack id="activity-build-details" gap="sm" class="rounded-md bg-muted/35 p-3">
						<p class="text-xs text-foreground">{receipt.summary}</p>
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-micro">
							<dt class="text-muted-foreground">{t('bolt.studio.phase')}</dt>
							<dd>{buildPhaseLabel(receipt.phase)}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.commit')}</dt>
							<dd class="break-all font-mono">{receipt.commit}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.cache')}</dt>
							<dd>{cacheLabel(receipt.cache)}</dd>
							{#if duration !== undefined}<dt class="text-muted-foreground">
									{t('bolt.studio.duration')}
								</dt>
								<dd>{duration}</dd>{/if}
						</dl>
						{#if receipt.stdout !== undefined}
							<pre
								class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro text-foreground">{receipt.stdout}</pre>
						{/if}
						{#if receipt.stderr !== undefined}
							<pre
								class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro text-destructive">{receipt.stderr}</pre>
						{/if}
					</Stack>
				{/if}
			</Stack>
		{/if}

		<Stack as="section" gap="sm">
			<h3 class="text-overline">{t('bolt.studio.usage')}</h3>
			{#if snapshot === undefined || (snapshot.usage.length === 0 && snapshot.usageEstimate === null)}
				<p class="text-meta">{t('bolt.studio.usageUnavailable')}</p>
			{:else}
				{#if snapshot.usageEstimate !== null}
					<Stack gap="sm" class="rounded-md bg-muted/35 p-3">
						<Inline gap="lg" align="start" class="flex-wrap">
							<Stack gap="none">
								<span class="text-micro text-muted-foreground">{t('bolt.studio.monthToDate')}</span>
								<strong class="text-sm font-semibold text-foreground">
									{formatMicroSgd(snapshot.usageEstimate.monthToDateMicroSgd)}
								</strong>
							</Stack>
							<Stack gap="none">
								<span class="text-micro text-muted-foreground">{t('bolt.studio.projected')}</span>
								<strong class="text-sm font-semibold text-foreground">
									{formatMicroSgd(snapshot.usageEstimate.projectedMicroSgd)}
								</strong>
							</Stack>
						</Inline>
						{#if usagePeriod !== undefined}
							<p class="text-micro text-muted-foreground">
								{usagePeriod} · {t('bolt.studio.serverEstimate')}
							</p>
						{/if}
						{#if snapshot.usageEstimate.meters.length > 0}
							<ul class="divide-y divide-border/40 border-y border-border/40">
								{#each snapshot.usageEstimate.meters as meter (meter.kind)}
									<li class="grid grid-cols-[1fr_auto] gap-x-4 py-1.5 text-micro">
										<span class="text-foreground">{meter.kind}</span>
										<span class="tabular-nums text-muted-foreground">
											{quantity.format(meter.monthToDateQuantity)} → {quantity.format(
												meter.projectedQuantity
											)}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					</Stack>
				{:else}
					<p class="text-meta">{t('bolt.studio.periodEstimateUnavailable')}</p>
				{/if}
				<dl class="divide-y divide-border/50 border-y border-border/50">
					{#each metrics as metric (metric.id)}
						<div class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-2">
							<dt class="text-xs text-foreground">{t(metric.labelKey)}</dt>
							<dd class="text-xs font-medium tabular-nums text-foreground">
								{metric.value ?? t('bolt.studio.notMeasured')}
							</dd>
							<dd class="col-span-2 text-micro text-muted-foreground">
								{metric.detailValues === undefined
									? t(metric.detailKey)
									: t(metric.detailKey, metric.detailValues)}
							</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</Stack>

		<Stack as="section" gap="sm">
			{@render disclosureButton(
				t('bolt.studio.history'),
				historyOpen,
				'activity-history',
				() => (historyOpen = !historyOpen)
			)}
			{#if historyOpen}
				<Stack id="activity-history" gap="md">
					<Stack gap="xs">
						<h4 class="text-micro font-semibold text-foreground">
							{t('bolt.studio.workbenchCommits')}
						</h4>
						{#if snapshot?.sourceHistory.length === 0 || snapshot === undefined}
							<p class="text-meta">{t('bolt.studio.noWorkbenchCommits')}</p>
						{:else}
							<ul class="max-h-48 overflow-auto divide-y divide-border/40">
								{#each [...snapshot.sourceHistory].reverse() as commit (commit.commit)}
									<li class="py-2 font-mono text-micro text-foreground">
										{t('bolt.studio.commitFileCount', {
											commit: commit.commit.slice(0, 12),
											count: commit.changes.length
										})}
									</li>
								{/each}
							</ul>
						{/if}
					</Stack>
					<Stack gap="xs">
						<h4 class="text-micro font-semibold text-foreground">{t('bolt.studio.deployments')}</h4>
						{#if snapshot?.deploymentHistory.length === 0 || snapshot === undefined}
							<p class="text-meta">{t('bolt.studio.noDeployments')}</p>
						{:else}
							<ul class="max-h-48 overflow-auto divide-y divide-border/40">
								{#each [...snapshot.deploymentHistory].reverse() as releaseId, index (releaseId)}
									<li class="py-2 font-mono text-micro text-foreground">
										{releaseId}{index === 0 ? ` · ${t('bolt.studio.currentSuffix')}` : ''}
									</li>
								{/each}
							</ul>
						{/if}
					</Stack>
				</Stack>
			{/if}
		</Stack>

		<Stack as="section" gap="sm">
			{@render disclosureButton(
				t('bolt.studio.runtimeDetails'),
				runtimeOpen,
				'activity-runtime-details',
				() => (runtimeOpen = !runtimeOpen)
			)}
			{#if runtimeOpen}
				<Stack id="activity-runtime-details" gap="md" class="rounded-md bg-muted/35 p-3">
					<Cluster gap="xs">
						<Badge variant={currentRelease === undefined ? 'outline' : 'success'}>
							{currentRelease === undefined
								? t('bolt.studio.noRoutedRelease')
								: currentRelease.environmentId}
						</Badge>
						{#if snapshot !== undefined}
							<Badge variant={snapshot.capacity.queued > 0 ? 'warning' : 'outline'}>
								{t('bolt.studio.activeCapacity', {
									active: snapshot.capacity.active,
									limit: snapshot.capacity.limit
								})}
							</Badge>
						{/if}
					</Cluster>
					{#if currentRelease !== undefined}
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-micro">
							<dt class="text-muted-foreground">{t('bolt.studio.release')}</dt>
							<dd class="break-all font-mono">{currentRelease.releaseId}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.artifact')}</dt>
							<dd class="break-all font-mono">{currentRelease.artifactId}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.commit')}</dt>
							<dd class="break-all font-mono">{snapshot?.source.commit}</dd>
						</dl>
					{/if}
					{#if missingFacilities.length > 0}
						<p class="text-micro text-amber-700 dark:text-amber-300">
							{t('bolt.studio.unavailableFacilities', {
								facilities: missingFacilities.map((facility) => facility.name).join(', ')
							})}
						</p>
					{/if}
					{#if snapshot !== undefined && snapshot.entries.length > 0}
						<ul class="max-h-48 overflow-auto divide-y divide-border/40 border-y border-border/40">
							{#each snapshot.entries as entry (`${entry.tenantId}:${entry.environmentId}`)}
								<li class="py-2 text-micro">
									<p class="font-medium text-foreground">{entry.environmentId}</p>
									<p class="break-all font-mono text-muted-foreground">
										{entry.releaseId} · {entry.artifactId}
									</p>
								</li>
							{/each}
						</ul>
					{/if}
					<Button
						type="button"
						size="sm"
						variant="outline"
						class="w-fit"
						disabled={controls?.canRollback !== true}
						disabledMessage={controls?.reasonKey === undefined
							? t('bolt.studio.noEarlierRelease')
							: t(controls.reasonKey)}
						onclick={() => onrollback?.()}
					>
						{t('bolt.studio.rollback')}
					</Button>
				</Stack>
			{/if}
		</Stack>
	</Stack>
</Scroll>
