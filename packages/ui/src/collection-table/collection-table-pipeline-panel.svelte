<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster, Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { CollectionTablePipeline } from '#lib/collection-table/collection-table.types';

	const { t } = useI18n<UiKeys>();

	let {
		kind,
		pipelines,
		selectedRows,
		disabled,
		pendingOperation,
		onRun
	}: {
		kind: 'import' | 'export';
		pipelines: readonly CollectionTablePipeline<TRow>[];
		selectedRows: readonly TRow[];
		disabled: boolean;
		pendingOperation: string | null;
		onRun(pipeline: CollectionTablePipeline<TRow>): void;
	} = $props();

	function disabledReason(pipeline: CollectionTablePipeline<TRow>): string | null {
		if (pipeline.requiresSelection && selectedRows.length === 0)
			return t('table.pipelineSelectRows', { label: pipeline.label });
		return pipeline.getDisabledReason?.(selectedRows) ?? null;
	}
</script>

{#if pipelines.length === 0}
	<Stack gap="sm" align="center" justify="center" class="min-h-32 px-5 py-8 text-center">
		<Icon
			icon={kind === 'export' ? 'lucide:download' : 'lucide:upload'}
			class="size-5 text-muted-foreground"
		/>
		<p class="text-sm font-medium">{t('table.noPipelinesConfigured', { kind })}</p>
		<p class="max-w-xs text-meta">
			{t('table.noPipelinesDeclared', { kind })}
		</p>
	</Stack>
{:else}
	<Stack gap="sm" class="pb-2">
		{#each pipelines as pipeline (pipeline.id)}
			{@const { id: pipelineId } = pipeline}
			{@const isRunning = pendingOperation === `${kind}:${pipelineId}`}
			{@const reason = disabledReason(pipeline)}
			<section class="rounded-md border border-border bg-background p-3 shadow-xs">
				<Inline align="start" gap="md">
					<div
						class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						<Icon
							icon={pipeline.icon ?? (kind === 'export' ? 'lucide:download' : 'lucide:upload')}
							class="size-4"
						/>
					</div>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium">{pipeline.label}</p>
						<Stack gap="sm">
							<p class="text-xs leading-relaxed text-muted-foreground">
								{pipeline.description ??
									t('table.pipelineDescription', { label: pipeline.label, kind })}
							</p>
							{#if reason}
								<p class="text-xs leading-relaxed text-muted-foreground">{reason}</p>
							{/if}
						</Stack>
					</div>
					<Button
						type="button"
						size="sm"
						class="shrink-0"
						aria-label={t('table.runPipeline', { label: pipeline.label })}
						disabled={disabled || pendingOperation !== null || reason != null}
						onclick={() => onRun(pipeline)}
					>
						<Icon
							icon={isRunning ? 'lucide:loader-circle' : 'lucide:play'}
							class={cn('size-4', isRunning && 'animate-spin')}
						/>
						{t('table.run')}
					</Button>
				</Inline>
			</section>
		{/each}
	</Stack>
{/if}
