<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import {
		reviewFreshness,
		reviewFreshnessMessageKey,
		reviewOwnerMessageKey,
		reviewRelativeTime,
		type ReleaseRequest
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		releaseRequests = [],
		selectedRequestId,
		currentReleaseId,
		busy = false,
		canDecide = false,
		failure,
		onpreview,
		onapprove,
		onrequestchanges,
		onreject
	}: {
		releaseRequests?: ReadonlyArray<ReleaseRequest>;
		selectedRequestId?: string | undefined;
		currentReleaseId?: string | undefined;
		busy?: boolean;
		canDecide?: boolean;
		failure?: string | undefined;
		onpreview?: ((requestId: string) => void) | undefined;
		onapprove?: ((requestId: string) => void) | undefined;
		onrequestchanges?: ((requestId: string, reason: string) => void) | undefined;
		onreject?: ((requestId: string, reason: string) => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const selected = $derived(
		releaseRequests.find((request) => request.id === selectedRequestId) ?? releaseRequests.at(-1)
	);
	const freshness = $derived(
		selected === undefined ? undefined : reviewFreshness(selected, currentReleaseId)
	);
	const canActOnReview = $derived(
		selected?.status === 'open' && canDecide && freshness === 'current'
	);
	let reviewReason = $state('');
	let filesOpen = $state(false);
	let schemaOpen = $state(false);
	const relativeTimeLabel = (iso: string): string => {
		const relative = reviewRelativeTime(iso, Date.now());
		return relative.count === undefined
			? t(relative.messageKey)
			: t(relative.messageKey, { count: relative.count });
	};
</script>

{#snippet disclosure(label: string, open: boolean, id: string, toggle: () => void)}
	<Button
		type="button"
		variant="ghost"
		class="h-auto w-full justify-between px-0 py-0 text-xs font-semibold"
		aria-expanded={open}
		aria-controls={id}
		onclick={toggle}
	>
		<span>{label}</span>
		<Icon icon={open ? 'lucide:chevron-up' : 'lucide:chevron-down'} class="size-3.5" />
	</Button>
{/snippet}

{#if selected === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-center">
		<Icon icon="lucide:git-compare" class="size-9 text-muted-foreground/30" />
		<p class="text-sm font-medium text-foreground">{t('bolt.studio.noReviews')}</p>
	</Stack>
{:else}
	<Scroll name={t('bolt.studio.reviews')} grow>
		<Stack gap="lg" class="p-4 sm:p-6" data-testid="studio-release-review">
			{#if failure !== undefined}
				<p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
					{failure}
				</p>
			{/if}
			<Stack as="header" gap="sm" class="border-b border-border/60 pb-4">
				<Inline align="start" gap="sm" class="flex-wrap sm:flex-nowrap">
					<Stack gap="xs" grow class="min-w-0">
						<Cluster gap="xs">
							<h2 class="text-sm font-semibold text-foreground">
								{t('bolt.studio.commitValue', { commit: selected.commit.slice(0, 12) })}
							</h2>
							<span
								class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-foreground"
								data-testid="studio-release-request-status"
							>
								{t(reviewFreshnessMessageKey(selected, currentReleaseId))}
							</span>
						</Cluster>
						<p class="text-micro text-muted-foreground">
							{t('bolt.studio.reviewMetadata', {
								author: selected.authorId,
								base: selected.baseCommit.slice(0, 12),
								created: relativeTimeLabel(selected.createdAt),
								updated: relativeTimeLabel(selected.updatedAt),
								next: t(reviewOwnerMessageKey(selected, currentReleaseId))
							})}
						</p>
						<p class="text-micro text-muted-foreground">
							{t('bolt.studio.reviewCounts', {
								files: selected.changedFiles.length,
								steps: selected.schemaPlan.steps.length
							})}
						</p>
					</Stack>
					{#if selected.status === 'open'}
						<Button
							type="button"
							size="sm"
							variant="outline"
							class="w-full sm:w-auto"
							disabled={busy}
							onclick={() => onpreview?.(selected.id)}
						>
							<Icon icon="lucide:scan-eye" class="size-3.5" />
							{t('bolt.studio.openPreview')}
						</Button>
					{/if}
				</Inline>
			</Stack>

			{#if selected.reason !== null}
				<p class="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					{selected.reason}
				</p>
			{/if}

			<Stack gap="none" class="divide-y divide-border/50 border-y border-border/50">
				<Stack as="section" gap="sm" class="py-3">
					{@render disclosure(
						t('bolt.studio.changedFiles', { count: selected.changedFiles.length }),
						filesOpen,
						'review-file-diffs',
						() => (filesOpen = !filesOpen)
					)}
					{#if filesOpen}
						<Stack id="review-file-diffs" gap="sm">
							{#if selected.changedFiles.length === 0}
								<p class="text-meta">{t('bolt.studio.noChangedFiles')}</p>
							{:else}
								{#each selected.changedFiles as file (file.path)}
									<Stack
										gap="none"
										class="max-w-full overflow-hidden rounded-md border border-border/70"
									>
										<p
											class="border-b border-border/70 bg-muted/40 px-3 py-2 font-mono text-micro text-foreground"
										>
											{file.path}
										</p>
										<Grid
											minimum="compact"
											gap="none"
											class="divide-y divide-border/60 md:grid-cols-2 md:divide-x md:divide-y-0"
										>
											<Stack gap="xs" class="min-w-0 overflow-auto p-3">
												<span class="text-micro font-medium text-foreground"
													>{t('bolt.studio.before')}</span
												>
												<pre
													class="max-h-80 whitespace-pre-wrap break-all font-mono text-micro text-foreground">{file.before ??
														'∅'}</pre>
											</Stack>
											<Stack gap="xs" class="min-w-0 overflow-auto p-3">
												<span class="text-micro font-medium text-foreground"
													>{t('bolt.studio.after')}</span
												>
												<pre
													class="max-h-80 whitespace-pre-wrap break-all font-mono text-micro text-foreground">{file.after}</pre>
											</Stack>
										</Grid>
									</Stack>
								{/each}
							{/if}
						</Stack>
					{/if}
				</Stack>

				<Stack as="section" gap="sm" class="py-3">
					{@render disclosure(
						t('bolt.studio.schemaPlan', { count: selected.schemaPlan.steps.length }),
						schemaOpen,
						'review-schema-plan',
						() => (schemaOpen = !schemaOpen)
					)}
					{#if schemaOpen}
						<Stack id="review-schema-plan" gap="sm">
							<p class="break-all font-mono text-micro text-muted-foreground">
								{selected.schemaPlan.fingerprint}
							</p>
							{#if selected.schemaPlan.steps.length === 0}
								<p class="text-meta">{t('bolt.studio.noSchemaSteps')}</p>
							{:else}
								<ul
									class="max-h-96 overflow-auto divide-y divide-border/50 rounded-md border border-border/70"
								>
									{#each selected.schemaPlan.steps as step (step.id)}
										<li class="px-3 py-2">
											<p class="text-micro text-muted-foreground">{step.id}</p>
											<pre
												class="whitespace-pre-wrap break-all font-mono text-micro text-foreground">{step.sql}</pre>
										</li>
									{/each}
								</ul>
							{/if}
						</Stack>
					{/if}
				</Stack>
			</Stack>

			{#if canActOnReview}
				<Stack gap="sm" class="rounded-md border border-border/70 p-3">
					<h3 class="text-xs font-semibold text-foreground">{t('bolt.studio.decision')}</h3>
					<Textarea
						bind:value={reviewReason}
						rows={3}
						placeholder={t('bolt.studio.reviewReason')}
						aria-label={t('bolt.studio.reviewReasonAria')}
					/>
					<Cluster gap="xs">
						<Button
							type="button"
							size="sm"
							disabled={busy}
							onclick={() => onapprove?.(selected.id)}
						>
							{t('bolt.studio.approveRelease')}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy || reviewReason.trim() === ''}
							onclick={() => onrequestchanges?.(selected.id, reviewReason.trim())}
						>
							{t('bolt.studio.requestChanges')}
						</Button>
					</Cluster>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						class="w-fit px-0 text-destructive hover:text-destructive"
						disabled={busy || reviewReason.trim() === ''}
						onclick={() => onreject?.(selected.id, reviewReason.trim())}
					>
						{t('bolt.studio.closeReview')}
					</Button>
				</Stack>
			{:else if selected.status === 'open' && freshness === 'live_advanced'}
				<p class="text-xs text-amber-700 dark:text-amber-300">
					{t('bolt.studio.rebaseRequired')}
				</p>
			{:else if selected.status === 'open'}
				<p class="text-xs text-muted-foreground">{t('bolt.studio.waitingReviewer')}</p>
			{:else if selected.status === 'approving'}
				<p class="text-xs text-amber-700 dark:text-amber-300">
					{t('bolt.studio.applyingPreview')}
				</p>
			{:else if selected.status === 'changes_requested' || selected.status === 'rejected'}
				<p class="text-xs text-muted-foreground">
					{t('bolt.studio.updateAfterReview')}
				</p>
			{/if}
		</Stack>
	</Scroll>
{/if}
