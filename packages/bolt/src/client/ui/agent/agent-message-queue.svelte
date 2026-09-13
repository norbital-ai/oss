<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Sortable } from '@norbital-ai/ui/sortable';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { plainMessageText } from './context-view.js';
	import type { PanelMessage } from './transcript.js';

	let {
		messages,
		pendingText,
		busy = false,
		onsteer,
		onremove,
		onreorder
	}: {
		messages: readonly PanelMessage[];
		pendingText?: string | undefined;
		busy?: boolean;
		onsteer: (id: string) => void;
		onremove: (id: string) => void;
		onreorder: (ids: string[]) => void;
	} = $props();
	let list = $state<HTMLElement | null>(null);
	const ids = $derived(
		messages.filter((message) => message.priority !== 'steer').map((message) => message.id)
	);
</script>

{#if messages.length > 0 || pendingText !== undefined}
	<Stack gap="xs" class="min-w-0" data-agent-queue>
		<span class="text-xs text-muted-foreground"
			>Queued · {messages.length + Number(pendingText !== undefined)}</span
		>
		<Scroll name="Queued messages" style="height: auto; max-height: 8rem">
			<Sortable.Root
				element={list}
				items={ids}
				handle="agent-queue-drag"
				disabled={busy}
				onSort={onreorder}
			>
				{#snippet child()}
					<ol
						bind:this={list}
						class="m-0 list-none divide-y divide-border/70 rounded-md bg-muted/30 p-0"
						aria-label="Message queue"
					>
						{#each messages as message (message.id)}
							<li
								data-sortable-id={message.priority === 'steer' ? undefined : message.id}
								data-queue-message={message.id}
							>
								<Inline gap="xs" class="min-h-8 px-1 py-0.5 text-xs hover:bg-muted/50">
									<button
										type="button"
										data-queue-drag
										disabled={busy || message.priority === 'steer'}
										aria-label="Drag to reorder queued message"
										title="Drag to reorder"
										class="agent-queue-drag cursor-grab touch-none rounded p-1 text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
									>
										<Icon icon="lucide:grip-vertical" class="size-3.5" />
									</button>
									<span class="min-w-0 flex-1 truncate" title={plainMessageText(message)}
										>{plainMessageText(message) || 'Attached message'}</span
									>
									<button
										type="button"
										disabled={busy || message.priority === 'steer'}
										onclick={() => onsteer(message.id)}
										aria-label="Steer now"
										title="Submit to the current turn without interrupting its model call"
										class="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
									>
										{message.priority === 'steer' ? 'Steering…' : 'Steer now'}
									</button>
									<button
										type="button"
										disabled={busy}
										onclick={() => onremove(message.id)}
										aria-label="Remove queued message"
										title="Remove from queue"
										class="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
									>
										<Icon icon="lucide:x" class="size-3.5" />
									</button>
								</Inline>
							</li>
						{/each}
						{#if pendingText !== undefined}<li
								class="truncate px-2 py-1 text-xs text-muted-foreground"
								title={pendingText}
							>
								Sending · {pendingText}
							</li>{/if}
					</ol>
				{/snippet}
			</Sortable.Root>
		</Scroll>
	</Stack>
{/if}
