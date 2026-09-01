<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import {
		reviewFreshnessMessageKey,
		reviewOwnerMessageKey,
		reviewRelativeTime,
		type ReleaseRequest
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		requests = [],
		selectedRequestId,
		currentReleaseId,
		onselect
	}: {
		requests?: ReadonlyArray<ReleaseRequest>;
		selectedRequestId?: string | undefined;
		currentReleaseId?: string | undefined;
		onselect?: ((requestId: string) => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const ordered = $derived([...requests].reverse());
	const selected = $derived(
		requests.find((request) => request.id === selectedRequestId) ?? ordered[0]
	);
	const relativeTimeLabel = (iso: string): string => {
		const relative = reviewRelativeTime(iso, Date.now());
		return relative.count === undefined
			? t(relative.messageKey)
			: t(relative.messageKey, { count: relative.count });
	};
</script>

{#snippet sidebarHeading(icon: string, label: string)}
	<Inline gap="xs">
		<Icon {icon} class="size-3.5 text-muted-foreground" />
		<span class={cn('text-foreground', WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS)}>{label}</span>
	</Inline>
{/snippet}

<Stack gap="none" fill class="bg-card" data-testid="studio-review-sidebar">
	<Stack gap="xs" shrink={false} class="border-b border-border/60 px-2 py-1.5">
		{@render sidebarHeading('lucide:git-pull-request', t('bolt.studio.reviews'))}
	</Stack>
	<Scroll name={t('bolt.studio.reviews')} layout="stack" gap="xs" grow class="min-h-0 p-2">
		{#if ordered.length === 0}
			<p class="px-1 py-2 text-micro text-muted-foreground">{t('bolt.studio.noReviews')}</p>
		{:else}
			{#each ordered as request (request.id)}
				<button
					type="button"
					data-testid="studio-release-request-option"
					data-status={request.status}
					class={cn(
						'w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/70',
						request.id === selected?.id && 'bg-primary/5'
					)}
					onclick={() => onselect?.(request.id)}
				>
					<span class="block truncate text-xs font-medium text-foreground">
						{request.authorId}
					</span>
					<span class="block truncate font-mono text-micro text-muted-foreground">
						{t('bolt.studio.baseCommit', {
							commit: request.commit.slice(0, 12),
							base: request.baseCommit.slice(0, 12)
						})}
					</span>
					<span class="mt-1 block truncate text-micro text-muted-foreground">
						{t('bolt.studio.reviewTimeline', {
							freshness: t(reviewFreshnessMessageKey(request, currentReleaseId)),
							updated: relativeTimeLabel(request.updatedAt),
							next: t(reviewOwnerMessageKey(request, currentReleaseId))
						})}
					</span>
					<span class="block truncate text-micro text-muted-foreground">
						{t('bolt.studio.reviewCounts', {
							files: request.changedFiles.length,
							steps: request.schemaPlan.steps.length
						})}
					</span>
				</button>
			{/each}
		{/if}
	</Scroll>
</Stack>
