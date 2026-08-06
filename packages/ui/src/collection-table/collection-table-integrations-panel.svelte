<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, Stack } from '#lib/layout';
	import type {
		CollectionTableIntegrationState,
		CollectionTableIntegrationStatus
	} from './collection-table.types.js';

	const { t } = useI18n<UiKeys>();

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
	<Stack gap="sm" align="center" justify="center" class="min-h-32 px-5 py-8 text-center">
		<p class="text-sm font-medium">{t('table.noIntegrationsConfigured')}</p>
		<p class="max-w-xs text-xs text-muted-foreground">
			{t('table.noIntegrationsDescription')}
		</p>
	</Stack>
{:else}
	<div class="divide-y">
		{#each integrations as integration (integration.id)}
			<Inline align="start" gap="md" class="px-4 py-3">
				<span class={cn('mt-1.5 size-2 shrink-0 rounded-full', statusClass(integration.state))}
				></span>
				<div class="min-w-0 flex-1">
					<Inline justify="between" gap="md">
						<p class="truncate text-sm font-medium">{integration.label}</p>
						<span class="shrink-0 text-micro capitalize text-muted-foreground">
							{integration.statusLabel ?? integration.state}
						</span>
					</Inline>
					{#if integration.description}
						<p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
							{integration.description}
						</p>
					{/if}
				</div>
			</Inline>
		{/each}
	</div>
{/if}
