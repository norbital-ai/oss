<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import type { LiveReleaseRow } from '#lib/client/ui/studio/studio-state.js';

	let {
		releases = [],
		selectedReleaseId,
		onselect
	}: {
		releases?: ReadonlyArray<LiveReleaseRow>;
		selectedReleaseId?: string | undefined;
		onselect?: ((releaseId: string) => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const selected = $derived(
		releases.find((release) => release.releaseId === selectedReleaseId) ?? releases[0]
	);
</script>

<Stack gap="none" fill class="bg-card" data-testid="studio-live-sidebar">
	<Stack gap="xs" shrink={false} class="border-b border-border/60 px-2 py-1.5">
		<Inline gap="xs">
			<Icon icon="lucide:history" class="size-3.5 text-muted-foreground" />
			<span class={cn('text-foreground', WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS)}>
				{t('bolt.studio.live')}
			</span>
		</Inline>
	</Stack>
	<Scroll name={t('bolt.studio.live')} layout="stack" gap="xs" grow class="min-h-0 p-2">
		{#if releases.length === 0}
			<p class="px-1 py-2 text-micro text-muted-foreground">{t('bolt.studio.noReleases')}</p>
		{:else}
			{#each releases as release (release.releaseId)}
				<button
					type="button"
					data-testid="studio-live-release-option"
					class={cn(
						'w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/70',
						release.releaseId === selected?.releaseId && 'bg-primary/5'
					)}
					onclick={() => onselect?.(release.releaseId)}
				>
					<span class="block truncate font-mono text-xs font-medium text-foreground">
						{release.releaseId}
					</span>
					{#if release.current}
						<span class="mt-1 block text-micro text-muted-foreground">
							{t('bolt.studio.currentRelease')}
						</span>
					{/if}
					{#if release.commit !== undefined}
						<span class="block truncate font-mono text-micro text-muted-foreground">
							{release.commit.slice(0, 12)}
						</span>
					{/if}
					{#if release.checkpointAt !== undefined}
						<span class="block text-micro text-muted-foreground">
							{t('bolt.studio.restoreCheckpoint', { at: release.checkpointAt })}
						</span>
					{/if}
					{#if release.artifactId !== undefined}
						<span class="block truncate font-mono text-micro text-muted-foreground">
							{release.artifactId}
						</span>
					{/if}
				</button>
			{/each}
		{/if}
	</Scroll>
</Stack>
