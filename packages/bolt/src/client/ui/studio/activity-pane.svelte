<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Badge } from '@norbital-ai/ui/badge';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		currentRoutedRelease,
		evidenceLogs,
		formatMicroSgd,
		reviewStatusMessageKey,
		studioMetrics,
		type HostSnapshot,
		type ReleaseControls,
		type WorkbenchBuildReceipt
	} from '#lib/client/ui/studio/studio-state.js';
	import type { AuthoringLiveState } from '#lib/client/ui/studio/authoring-live.js';

	let {
		snapshot,
		hostStatus,
		controls,
		liveLogs = [],
		memory = null,
		onrollback
	}: {
		snapshot?: HostSnapshot | undefined;
		hostStatus: string;
		controls?: ReleaseControls | undefined;
		liveLogs?: AuthoringLiveState['logs'];
		memory?: AuthoringLiveState['memory'];
		onrollback?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	let buildOpen = $state(false);
	let deployOpen = $state(false);
	let historyOpen = $state(false);
	let runtimeOpen = $state(false);
	const currentRelease = $derived(currentRoutedRelease(snapshot?.entries ?? []));
	const logs = $derived(evidenceLogs(snapshot));
	const metrics = $derived(
		studioMetrics({ usage: snapshot?.usage ?? [], source: snapshot?.source })
	);
	const openReview = $derived(
		[...(snapshot?.mergeRequests ?? [])]
			.reverse()
			.find((request) => request.state === 'draft' || request.state === 'ready')
	);
	const missingFacilities = $derived(
		(snapshot?.facilities ?? []).filter((facility) => !facility.available)
	);
	const duration = $derived.by(() => {
		if (logs.build === undefined) return undefined;
		const milliseconds = Date.parse(logs.build.completedAt) - Date.parse(logs.build.startedAt);
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
		{#if memory !== null || liveLogs.length > 0}
			<Stack gap="sm">
				<h3 class="text-overline">{t('bolt.studio.live.logs')}</h3>
				{#if memory !== null}
					<p class="text-xs text-muted-foreground" data-testid="studio-workbench-memory">
						{t('bolt.studio.live.memory', { rss: memory.rssMiB, limit: memory.limitMiB })}
					</p>
				{/if}
				{#if liveLogs.length > 0}
					<ol class="divide-y divide-border/50 border-y border-border/50">
						{#each liveLogs.slice(-12) as entry (entry.at + entry.line)}
							<li class="py-1.5 font-mono text-micro text-foreground">{entry.line}</li>
						{/each}
					</ol>
				{/if}
			</Stack>
		{/if}
		<Stack gap="sm">
			<h3 class="text-overline">{t('bolt.studio.latest')}</h3>
			<ol class="divide-y divide-border/50 border-y border-border/50">
				{#if logs.build !== undefined}
					<li class="py-2">
						<Inline gap="sm" align="start">
							<Icon
								icon={logs.build.outcome === 'succeeded'
									? 'lucide:circle-check'
									: 'lucide:circle-alert'}
								class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
							/>
							<Stack gap="xs" grow class="min-w-0">
								<p class="text-xs font-medium text-foreground">
									{t('bolt.studio.previewOutcome', { outcome: buildOutcomeLabel(logs.build.outcome) })}
								</p>
								<p class="text-micro text-muted-foreground">{logs.build.summary}</p>
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
										status: t(reviewStatusMessageKey(openReview.state))
									})}
								</p>
								<p class="text-micro text-muted-foreground">
									{openReview.openedBy} · {openReview.head.slice(0, 12)}
								</p>
							</Stack>
						</Inline>
					</li>
				{/if}
				{#if logs.build === undefined && snapshot?.preview == null && openReview === undefined}
					<li class="py-2 text-meta">{hostStatus}</li>
				{/if}
			</ol>
		</Stack>

		{#if logs.build !== undefined}
			<Stack as="section" gap="sm">
				{@render disclosureButton(
					t('bolt.studio.buildDetails'),
					buildOpen,
					'activity-build-details',
					() => (buildOpen = !buildOpen)
				)}
				{#if buildOpen}
					<Stack id="activity-build-details" gap="sm" class="rounded-md bg-muted/35 p-3">
						<p class="text-xs text-foreground">{logs.build.summary}</p>
						<Grid as="dl" gap="xs" tracks="auto 1fr" class="text-micro">
							<dt class="text-muted-foreground">{t('bolt.studio.phase')}</dt>
							<dd>{buildPhaseLabel(logs.build.phase)}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.commit')}</dt>
							<dd class="break-all font-mono">{logs.build.commit}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.cache')}</dt>
							<dd>{cacheLabel(logs.build.cache)}</dd>
							{#if duration !== undefined}<dt class="text-muted-foreground">
									{t('bolt.studio.duration')}
								</dt>
								<dd>{duration}</dd>{/if}
						</Grid>
						{#if logs.build.stdout !== undefined}
							<Scroll name="Build stdout" class="max-h-64">
							<pre
								class="whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro text-foreground">{logs.build.stdout}</pre>
							</Scroll>
						{/if}
						{#if logs.build.stderr !== undefined}
							<Scroll name="Build stderr" class="max-h-64">
							<pre
								class="whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro text-destructive">{logs.build.stderr}</pre>
							</Scroll>
						{/if}
					</Stack>
				{/if}
			</Stack>
		{/if}

		{#if logs.deploy.length > 0}
			<Stack as="section" gap="sm">
				{@render disclosureButton(
					t('bolt.studio.runtimeDetails'),
					deployOpen,
					'activity-deploy-details',
					() => (deployOpen = !deployOpen)
				)}
				{#if deployOpen}
					<Scroll id="activity-deploy-details" name="Deploy log" class="max-h-64">
						<ul class="rounded-md bg-muted/35 p-3 font-mono text-micro text-foreground">
							{#each logs.deploy as line, index (`${line.at}:${index}`)}
								<li class="whitespace-pre-wrap break-all">{line.at} {line.level} {line.line}</li>
							{/each}
						</ul>
					</Scroll>
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
									<Grid as="li" gap="sm" tracks="1fr auto" class="py-1.5 text-micro">
										<span class="text-foreground">{meter.kind}</span>
										<span class="tabular-nums text-muted-foreground">
											{quantity.format(meter.monthToDateQuantity)} → {quantity.format(
												meter.projectedQuantity
											)}
										</span>
									</Grid>
								{/each}
							</ul>
						{/if}
					</Stack>
				{:else}
					<p class="text-meta">{t('bolt.studio.periodEstimateUnavailable')}</p>
				{/if}
				<dl class="divide-y divide-border/50 border-y border-border/50">
					{#each metrics as metric (metric.id)}
						<Grid gap="xs" tracks="1fr auto" class="py-2">
							<dt class="text-xs text-foreground">{t(metric.labelKey)}</dt>
							<dd class="text-xs font-medium tabular-nums text-foreground">
								{metric.value ?? t('bolt.studio.notMeasured')}
							</dd>
							<dd class="col-span-2 text-micro text-muted-foreground">
								{metric.detailValues === undefined
									? t(metric.detailKey)
									: t(metric.detailKey, metric.detailValues)}
							</dd>
						</Grid>
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
							<Scroll name="Activity list" class="max-h-48">
							<ul class="divide-y divide-border/40">
								{#each [...snapshot.sourceHistory].reverse() as commit (commit.commit)}
									<li class="py-2 font-mono text-micro text-foreground">
										{t('bolt.studio.commitFileCount', {
											commit: commit.commit.slice(0, 12),
											count: commit.changes.length
										})}
									</li>
								{/each}
							</ul>
							</Scroll>
						{/if}
					</Stack>
					<Stack gap="xs">
						<h4 class="text-micro font-semibold text-foreground">{t('bolt.studio.deployments')}</h4>
						{#if snapshot?.deploymentHistory.length === 0 || snapshot === undefined}
							<p class="text-meta">{t('bolt.studio.noDeployments')}</p>
						{:else}
							<Scroll name="Activity list" class="max-h-48">
							<ul class="divide-y divide-border/40">
								{#each [...snapshot.deploymentHistory].reverse() as releaseId, index (releaseId)}
									<li class="py-2 font-mono text-micro text-foreground">
										{releaseId}{index === 0 ? ` · ${t('bolt.studio.currentSuffix')}` : ''}
									</li>
								{/each}
							</ul>
							</Scroll>
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
						<Grid as="dl" gap="xs" tracks="auto 1fr" class="text-micro">
							<dt class="text-muted-foreground">{t('bolt.studio.release')}</dt>
							<dd class="break-all font-mono">{currentRelease.releaseId}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.artifact')}</dt>
							<dd class="break-all font-mono">{currentRelease.artifactId}</dd>
							<dt class="text-muted-foreground">{t('bolt.studio.commit')}</dt>
							<dd class="break-all font-mono">{snapshot?.source.commit}</dd>
						</Grid>
					{/if}
					{#if missingFacilities.length > 0}
						<p class="text-micro text-amber-700 dark:text-amber-300">
							{t('bolt.studio.unavailableFacilities', {
								facilities: missingFacilities.map((facility) => facility.name).join(', ')
							})}
						</p>
					{/if}
					{#if snapshot !== undefined && snapshot.entries.length > 0}
							<Scroll name="Activity facilities" class="max-h-48">
							<ul class="divide-y divide-border/40 border-y border-border/40">
							{#each snapshot.entries as entry (`${entry.tenantId}:${entry.environmentId}`)}
								<li class="py-2 text-micro">
									<p class="font-medium text-foreground">{entry.environmentId}</p>
									<p class="break-all font-mono text-muted-foreground">
										{entry.releaseId} · {entry.artifactId}
									</p>
								</li>
							{/each}
						</ul>
							</Scroll>
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
