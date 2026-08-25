<script lang="ts" generics="T, TAdditionalProps extends Record<string, unknown> = {}">
	import Icon from '@iconify/svelte';
	import { Checkbox } from '#lib/checkbox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { TComboboxCommandItem } from '#lib/combobox/types';

	const { t } = useI18n<UiKeys>();

	interface Props {
		item: TComboboxCommandItem<T, TAdditionalProps>;
		multiple: boolean;
		itemHeight: number;
		groupHeaderHeight: number;
		searchQuery: string;
		compactTextClass: string;
		isValueSelected: (value: T) => boolean;
	}

	let {
		item,
		multiple,
		itemHeight,
		groupHeaderHeight,
		searchQuery,
		compactTextClass,
		isValueSelected
	}: Props = $props();
</script>

{#if item._type === 'group'}
	<div
		role="presentation"
		class={cn('text-overline flex items-center bg-muted px-3', compactTextClass)}
		style="height: {groupHeaderHeight}px;"
	>
		{item._groupName}
	</div>
{:else if item._type === 'option'}
	{@const selected = isValueSelected(item._option.value)}
	<div
		class={cn(
			'relative z-10 flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-3 text-left',
			compactTextClass,
			{
				'bg-accent text-accent-foreground': selected
			}
		)}
		style="height: {itemHeight}px;"
	>
		<Inline gap="sm" grow class="text-left">
			{#if item._option.icon}
				<Icon icon={item._option.icon} class="size-3.5 shrink-0 text-muted-foreground" />
			{/if}
			<div class="min-w-0 flex-1">
				<Inline gap="xs">
					<div class={cn('min-w-0 truncate', compactTextClass)}>
						{#if typeof item._option.label !== 'string'}
							{@render item._option.label(
								item._option.value,
								(item._option.additionalLabelProps ?? {}) as TAdditionalProps
							)}
						{:else}
							{item._option.label}
						{/if}
					</div>
					{#if item._option.badge}
						<span
							class="shrink-0 rounded border border-border/70 bg-muted/40 px-1 py-px text-tiny font-medium text-muted-foreground"
						>
							{item._option.badge}
						</span>
					{/if}
				</Inline>
				{#if item._option.description}
					<div class="truncate text-tiny leading-3 text-muted-foreground">
						{item._option.description}
					</div>
				{/if}
			</div>
		</Inline>
		{#if multiple}
			<Checkbox checked={selected} tabindex={-1} aria-hidden="true" class="scale-75" />
		{:else if selected}
			<Icon icon="lucide:check" class="h-3 w-3 text-foreground" />
		{/if}
	</div>
{:else if item._type === 'select-all'}
	<div
		class={cn(
			'relative z-10 flex w-full cursor-pointer items-center justify-between rounded-sm border-b border-border/60 px-3 text-left',
			compactTextClass,
			{ 'bg-accent text-accent-foreground': item._allSelected }
		)}
		style="height: {itemHeight}px;"
	>
		<Inline gap="sm">
			<Icon icon="lucide:list-checks" class="size-3.5 shrink-0 text-muted-foreground" />
			<div class="min-w-0">
				<div class="truncate font-medium">{item.label}</div>
				<div class="truncate text-tiny leading-3 text-muted-foreground">
					{t('common.selectedOfTotal', {
						selected: item._selectedCount,
						total: item._totalCount
					})}
				</div>
			</div>
		</Inline>
		<Checkbox
			checked={item._allSelected}
			indeterminate={item._selectedCount > 0 && !item._allSelected}
			tabindex={-1}
			aria-hidden="true"
			class="scale-75"
		/>
	</div>
{:else}
	<div
		class={cn(
			'relative z-10 flex w-full cursor-pointer items-center gap-2 rounded-sm px-3 text-left',
			'bg-accent text-accent-foreground',
			compactTextClass
		)}
		style="height: {itemHeight}px;"
	>
		<Icon icon="lucide:plus" class="h-3 w-3" />
		{t('common.createOption', { query: searchQuery })}
	</div>
{/if}
