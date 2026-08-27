<script lang="ts">
	import type { WorkspaceSyncStatus } from '#lib/client/runtime.js';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import {
		workspaceSyncNotices,
		type WorkspaceSyncNotice
	} from './sync-status-presentation.js';

	let { status }: { status: WorkspaceSyncStatus | undefined } = $props();

	const notices = $derived(workspaceSyncNotices(status));
	const issues = $derived(status?.issues ?? []);

	/**
	 * Notices float over the workspace instead of displacing it, so every card sits on an opaque
	 * popover surface rather than a translucent tone tint. A `*-foreground` token is contrast-proven
	 * against its *solid* tone, not against a 10% wash of it — on the dark theme that pairing put
	 * near-background text on a near-background panel. Tone now reaches the eye through the icon and
	 * the left rule, while the copy keeps the foreground pair that is legible in both themes.
	 */
	const toneClass = (tone: WorkspaceSyncNotice['tone']): string => {
		switch (tone) {
			case 'destructive':
				return 'border-l-destructive text-destructive';
			case 'warning':
				return 'border-l-warning text-warning';
			case 'info':
				return 'border-l-info text-info';
			case 'success':
				return 'border-l-success text-success';
			default:
				return 'border-l-border text-muted-foreground';
		}
	};
</script>

{#if notices.length > 0}
	<aside
		class="pointer-events-none fixed bottom-6 right-6 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
		aria-label="Workspace sync status"
		data-testid="workspace-sync-status"
		data-sync-status={status === undefined ? 'unavailable' : status.connectivity}
		data-pending-mutations={status?.pendingMutations ?? 'unverified'}
		data-stale-server-proof-windows={status?.staleServerProofWindows ?? 'unverified'}
		data-sync-issues={status?.issues.length ?? 'unverified'}
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
				<Stack gap="none" class="min-w-0">
					<p class="text-xs font-semibold leading-5 text-popover-foreground">{notice.title}</p>
					<p class="text-micro leading-4 text-muted-foreground">{notice.description}</p>
				</Stack>
			</Inline>
		{/each}

		{#if issues.length > 0}
			<details
				class="pointer-events-auto rounded-lg border border-l-4 border-l-destructive bg-popover text-destructive shadow-lg"
			>
				<summary
					class="cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				>
					Review sync issue details
				</summary>
				<ul class="max-h-40 space-y-2 overflow-y-auto border-t border-destructive/15 px-3 py-2">
					{#each issues as issue (issue.mutationId)}
						<li class="grid min-w-0 gap-x-2 gap-y-0.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
							<span class="font-semibold capitalize">{issue.kind}</span>
							<span class="break-words leading-5 text-popover-foreground">{issue.message}</span>
							<code
								class="col-span-full truncate text-micro text-muted-foreground sm:col-start-2"
								title={issue.mutationId}>{issue.mutationId}</code
							>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</aside>
{/if}
