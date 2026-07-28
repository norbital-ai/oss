<script lang="ts">
	import { cn } from '#lib/utils';
	import type {
		CollectionTableIntegrationState,
		CollectionTableIntegrationStatus
	} from './collection-table.types.js';

	let { integrations }: { integrations: readonly CollectionTableIntegrationStatus[] } = $props();

	function statusClass(state: CollectionTableIntegrationState): string {
		return cn(
			state === 'connected' && 'bg-success',
			state === 'configured' && 'bg-brand',
			state === 'degraded' && 'bg-amber-500',
			state === 'error' && 'bg-destructive',
			state === 'disabled' && 'bg-muted-foreground/45'
		);
	}
</script>

{#if integrations.length === 0}
	<div class="flex min-h-32 flex-col items-center justify-center gap-2 px-5 py-8 text-center">
		<p class="text-sm font-medium">No integrations configured</p>
		<p class="max-w-xs text-xs text-muted-foreground">
			This collection is not currently connected to an external integration.
		</p>
	</div>
{:else}
	<div class="divide-y">
		{#each integrations as integration (integration.id)}
			<div class="flex items-start gap-3 px-4 py-3">
				<span class={cn('mt-1.5 size-2 shrink-0 rounded-full', statusClass(integration.state))}
				></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-center justify-between gap-3">
						<p class="truncate text-sm font-medium">{integration.label}</p>
						<span class="shrink-0 text-micro capitalize text-muted-foreground">
							{integration.statusLabel ?? integration.state}
						</span>
					</div>
					{#if integration.description}
						<p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
							{integration.description}
						</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}
