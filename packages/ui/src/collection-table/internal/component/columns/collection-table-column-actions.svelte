<script lang="ts" generics="T extends Record<string, unknown>, TCondition = unknown">
	import {
		COLLECTION_TABLE_SELECTION_COLUMN_ID,
		type ColumnAPI,
		type TableAPI
	} from '../../collection-table-state.svelte';
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Indicator } from '#lib/indicator';
	import { Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { Separator } from '#lib/separator';
	import { cn } from '#lib/utils';

	const { t } = useI18n<UiKeys>();

	const { inst, table }: { inst: ColumnAPI<T, TCondition>; table: TableAPI<T, TCondition> } =
		$props();

	let isPopoverOpen = $state(false);

	const displayOptions = $derived(inst.displayOptions ?? []);
	const currentDisplay = $derived(inst.currentDisplay ?? '');
	const onDisplayChange = $derived(inst.onDisplayChange);

	const isColumnActive = $derived(inst.isPinned);
</script>

{#if inst.enablePinning || inst.enableHiding}
	<Popover.Root bind:open={isPopoverOpen}>
		<Popover.Trigger
			aria-label={t('table.columnActions')}
			class={cn(
				buttonVariants({ variant: 'ghost', size: 'icon' }),
				'mr-3 transition-opacity focus-visible:opacity-100',
				isPopoverOpen || isColumnActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
				isColumnActive && 'bg-muted-foreground/10 hover:bg-muted-foreground/20'
			)}
		>
			<Indicator visible={Boolean(isColumnActive)} variant="info" size="sm">
				<Icon icon="lucide:more-vertical" class="h-3.5 w-3.5" />
			</Indicator>
		</Popover.Trigger>

		<Popover.Content align="start" class="flex flex-col gap-2 p-2 py-4">
			<Stack gap="xs">
				<div class="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
					{t('table.display')}
				</div>

				{#if inst.enableHiding}
					<button
						class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
						onclick={() => inst.toggleVisibility()}
					>
						<Icon icon={inst.isVisible ? 'lucide:eye-off' : 'lucide:eye'} class="mr-2 h-3 w-3" />
						{inst.isVisible ? t('table.hideColumn') : t('table.showColumn')}
					</button>
				{/if}

				{#if inst.enablePinning}
					<button
						class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40"
						disabled={inst.id === COLLECTION_TABLE_SELECTION_COLUMN_ID}
						onclick={() => inst.id !== COLLECTION_TABLE_SELECTION_COLUMN_ID && inst.togglePin()}
					>
						<Icon icon={inst.isPinned ? 'lucide:pin-off' : 'lucide:pin'} class="mr-2 h-3 w-3" />
						{inst.isPinned ? t('table.unpinColumn') : t('table.pinColumn')}
					</button>
				{/if}

				{#if displayOptions.length > 0 && onDisplayChange}
					<Separator />
					<div class="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{t('table.format')}
					</div>
					{#each displayOptions as option (option.value)}
						<button
							class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
							onclick={() => onDisplayChange(option.value)}
						>
							<Icon
								icon={currentDisplay === option.value ? 'lucide:check' : 'lucide:circle'}
								class="mr-2 h-3 w-3"
							/>
							{option.label}
						</button>
					{/each}
				{/if}
			</Stack>

			{#if inst.enableResizing}
				<div class="mt-1">
					<Separator />
					<div class="px-2 pt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{t('table.sizing')}
					</div>
					<Stack gap="none">
						<button
							class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
							onclick={() => {
								delete table.columnSizing.current[inst.id];
							}}
						>
							<Icon icon="lucide:undo-2" class="mr-2 h-3.5 w-3.5" />
							{t('table.resetWidth')}
						</button>
						<button
							class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
							onclick={() => {
								table.fitColumn(inst.id);
							}}
						>
							<Icon icon="lucide:scan" class="mr-2 h-3.5 w-3.5" />
							{t('table.fitColumn')}
						</button>
						<button
							class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
							onclick={() => table.fitAllColumns()}
						>
							<Icon icon="lucide:scan-line" class="mr-2 h-3.5 w-3.5" />
							{t('table.fitAll')}
						</button>
					</Stack>
				</div>
			{/if}
		</Popover.Content>
	</Popover.Root>
{/if}
