<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import type { ReleaseRequest } from '#lib/client/ui/studio/studio-state.js';

	/** Reviews for this workspace, newest first. The selected diff stays in the main pane. */
	let {
		requests = [],
		selectedRequestId,
		onselect
	}: {
		requests?: ReadonlyArray<ReleaseRequest>;
		selectedRequestId?: string | undefined;
		onselect?: ((requestId: string) => void) | undefined;
	} = $props();

	const ordered = $derived([...requests].reverse());
	const selected = $derived(
		requests.find((request) => request.id === selectedRequestId) ?? ordered[0]
	);
	const statusLabel = (status: ReleaseRequest['status']): string => status.replaceAll('_', ' ');
</script>

{#snippet sidebarHeading(icon: string, label: string)}
	<Inline gap="xs">
		<Icon {icon} class="size-3.5 text-muted-foreground" />
		<span class={cn('text-foreground', WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS)}>{label}</span>
	</Inline>
{/snippet}

<Stack gap="none" fill class="bg-card" data-testid="studio-review-sidebar">
	<Stack gap="xs" shrink={false} class="border-b border-border/60 px-2 py-1.5">
		{@render sidebarHeading('lucide:git-pull-request', 'Reviews')}
	</Stack>
	<Scroll name="Reviews" layout="stack" gap="xs" grow class="min-h-0 p-2">
		{#if ordered.length === 0}
			<p class="px-1 py-2 text-micro leading-relaxed text-muted-foreground">
				No Reviews yet. Build Preview, then request Review.
			</p>
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
						Commit {request.commit.slice(0, 12)}
					</span>
					<span class="block truncate font-mono text-micro text-muted-foreground">
						{statusLabel(request.status)}
					</span>
				</button>
			{/each}
		{/if}
	</Scroll>
</Stack>
