<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { cn } from '#lib/utils';
	import type { CollectionTablePipeline } from './collection-table.types.js';

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
			return `Select one or more rows to run ${pipeline.label}.`;
		return pipeline.getDisabledReason?.(selectedRows) ?? null;
	}
</script>

{#if pipelines.length === 0}
	<div class="flex min-h-32 flex-col items-center justify-center gap-2 px-5 py-8 text-center">
		<Icon
			icon={kind === 'export' ? 'lucide:download' : 'lucide:upload'}
			class="size-5 text-muted-foreground"
		/>
		<p class="text-sm font-medium">No {kind} pipelines configured</p>
		<p class="max-w-xs text-xs text-muted-foreground">
			This collection does not currently declare a {kind} pipeline.
		</p>
	</div>
{:else}
	<div class="grid gap-2 pb-2">
		{#each pipelines as pipeline (pipeline.id)}
			{@const reason = disabledReason(pipeline)}
			<section class="rounded-md border border-border bg-background p-3 shadow-xs">
				<div class="flex items-start gap-3">
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
						<p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
							{pipeline.description ?? `${pipeline.label} ${kind} pipeline.`}
						</p>
						{#if reason}
							<p class="mt-2 text-xs leading-relaxed text-muted-foreground">{reason}</p>
						{/if}
					</div>
					<Button
						type="button"
						size="sm"
						class="shrink-0"
						aria-label={`Run ${pipeline.label}`}
						disabled={disabled || pendingOperation !== null || reason != null}
						onclick={() => onRun(pipeline)}
					>
						<Icon
							icon={pendingOperation === `${kind}:${pipeline.id}`
								? 'lucide:loader-circle'
								: 'lucide:play'}
							class={cn('size-4', pendingOperation === `${kind}:${pipeline.id}` && 'animate-spin')}
						/>
						Run
					</Button>
				</div>
			</section>
		{/each}
	</div>
{/if}
