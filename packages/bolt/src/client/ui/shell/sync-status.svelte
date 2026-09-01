<script lang="ts">
	import type { ClientState } from '#lib/client/sync/machine.js';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { workspaceSyncNotices, type WorkspaceSyncNotice } from './sync-status-presentation.js';

	let { state }: { state: ClientState | undefined } = $props();

	const notices = $derived(workspaceSyncNotices(state));

	const toneClass = (tone: WorkspaceSyncNotice['tone']): string =>
		tone === 'destructive'
			? 'border-l-destructive text-destructive'
			: 'border-l-warning text-warning';
</script>

{#if notices.length > 0}
	<aside
		class="pointer-events-none fixed bottom-6 right-6 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
		aria-label="Workspace sync status"
		data-testid="workspace-sync-status"
		data-sync-status={state?.link ?? 'unavailable'}
		data-pending-mutations={state?.writes.size ?? 'unavailable'}
	>
		{#each notices as notice (notice.key)}
			<Inline
				align="start"
				gap="sm"
				class={`pointer-events-auto min-w-0 rounded-lg border border-l-4 bg-popover px-3 py-2.5 shadow-lg ${toneClass(notice.tone)}`}
				role={notice.tone === 'destructive' ? 'alert' : 'status'}
				aria-live={notice.tone === 'destructive' ? 'assertive' : 'polite'}
			>
				<IconWrapper name={notice.icon} class="mt-0.5 size-4 shrink-0" />
				<Stack gap="xs" class="min-w-0">
					<p class="text-xs font-semibold leading-5 text-popover-foreground">{notice.title}</p>
					<p class="text-micro leading-4 text-muted-foreground">{notice.description}</p>
				</Stack>
			</Inline>
		{/each}
	</aside>
{/if}
