<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import { RELEASE_REQUEST_UNAVAILABLE, type SourceSnapshot } from '#lib/client/ui/studio/studio-state.js';

	/**
	 * Review's navigator: the release requests to choose from, and the files one changed.
	 *
	 * Both lists are empty here, and neither is empty because nothing is open. Colony's hosting layer
	 * has no release-request entity and no operation that compares two revisions, so a reader who saw
	 * "no open release requests" with nothing else would conclude that nobody had opened one. Each
	 * list names the service it does not have instead.
	 */
	let { source }: { source?: SourceSnapshot | undefined } = $props();

	const fileCount = $derived(Object.keys(source?.files ?? {}).length);
</script>

{#snippet sidebarHeading(icon: string, label: string)}
	<Inline gap="xs">
		<Icon {icon} class="size-3.5 text-muted-foreground" />
		<span class={cn('text-foreground', WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS)}>{label}</span>
	</Inline>
{/snippet}

<Stack gap="none" fill class="bg-card" data-testid="studio-review-sidebar">
	<Stack gap="xs" shrink={false} class="border-b border-border/60 px-2 py-1.5">
		{@render sidebarHeading('lucide:git-pull-request', 'Release requests')}
	</Stack>
	<Stack gap="xs" shrink={false} class="border-b border-border/60 px-3 py-3">
		<p class="text-micro leading-relaxed text-muted-foreground">No open release requests.</p>
		<p class="text-micro leading-relaxed text-amber-500" role="status">
			{RELEASE_REQUEST_UNAVAILABLE}
		</p>
	</Stack>

	<Stack gap="xs" shrink={false} class="border-b border-border/60 px-2 py-1.5">
		{@render sidebarHeading('lucide:git-compare-arrows', 'Changed files')}
	</Stack>
	<Scroll name="Changed files" layout="stack" gap="xs" grow class="min-h-0 px-3 py-3">
		<p class="text-micro leading-relaxed text-muted-foreground">
			The host holds one source snapshot per tenant — revision {source?.revision ?? 0},
			{fileCount} file{fileCount === 1 ? '' : 's'} — and no operation compares two of them, so there is
			no changed-files set to list.
		</p>
	</Scroll>
</Stack>
