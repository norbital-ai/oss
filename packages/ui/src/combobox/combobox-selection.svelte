<script
	lang="ts"
	generics="T, TAdditionalProps extends Record<string, unknown> = {}, TMultiple extends boolean = false"
>
	import Icon from '@iconify/svelte';
	import { AutoTruncator } from '#lib/auto-truncater';
	import { Badge } from '#lib/badge';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Bound, Cluster, Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { isEqual } from 'es-toolkit/predicate';
	import type { TComboboxProps, TOption } from '#lib/combobox/types';

	const { t } = useI18n<UiKeys>();

	type Option = TOption<T, TAdditionalProps>;

	let {
		value,
		multiple,
		display,
		emptyPlaceholder,
		readonly,
		truncate,
		options,
		selectedOptions,
		onRemove
	}: {
		value: TMultiple extends true ? T[] | null : T | null;
		multiple: boolean;
		display?: TComboboxProps<T, TAdditionalProps, TMultiple>['display'];
		emptyPlaceholder?: TComboboxProps<T, TAdditionalProps, TMultiple>['emptyPlaceholder'];
		readonly: boolean;
		truncate: boolean;
		options: Option[];
		selectedOptions: Option[];
		onRemove: (value: T, event: Event) => void;
	} = $props();

	const Track = $derived(truncate ? Inline : Cluster);
</script>

{#snippet defaultLabel()}
	{#if typeof emptyPlaceholder === 'string'}
		<span class={'font-normal text-muted-foreground text-xs'}>{emptyPlaceholder}</span>
	{:else if emptyPlaceholder}
		{@render emptyPlaceholder()}
	{:else}
		<span class={'font-normal text-muted-foreground text-xs'}>
			{t('common.selectOption')}
		</span>
	{/if}
{/snippet}

{#snippet compactBadge(option: Option)}
	{#if typeof option.label === 'string'}
		<Badge variant="outline" class="h-5 px-2 py-0">
			<Inline as="span" gap="xs">
				<span class="max-w-[80px] truncate text-left text-xs">{option.label}</span>
				{#if !readonly}
					<button
						type="button"
						class="ml-1 rounded-full hover:bg-secondary focus:ring-1 focus:ring-brand focus:outline-none"
						onclick={(event: MouseEvent) => onRemove(option.value, event)}
						aria-label={t('common.removeOption', { label: option.label })}
					>
						<Icon icon="lucide:x" class="h-2.5 w-2.5" />
					</button>
				{/if}
			</Inline>
		</Badge>
	{:else}
		<div>
			{@render option.label(
				option.value,
				(option.additionalLabelProps ?? {}) as TAdditionalProps,
				readonly ? undefined : (event: MouseEvent) => onRemove(option.value, event)
			)}
		</div>
	{/if}
{/snippet}

<!-- The selected labels clip at the trigger's edge. -->
<Bound size="auto" clip grow>
	<Track gap="xs" class={cn(truncate && 'whitespace-nowrap')}>
		{#if multiple}
			{#if display}
				{#if Array.isArray(value) && value.length > 0}
					{@render display(value as TMultiple extends true ? T[] : T)}
				{:else if selectedOptions.length}
					{@render display(
						selectedOptions.map((option) => option.value) as TMultiple extends true ? T[] : T
					)}
				{:else}
					{@render defaultLabel()}
				{/if}
			{:else if selectedOptions.length > 0}
				<AutoTruncator
					items={selectedOptions.map((option) => ({ ...option, key: String(option.value) }))}
					enabled={truncate}
					gap={4}
					class="min-w-0 flex-1"
				>
					{#snippet children(option: Option)}
						{@render compactBadge(option)}
					{/snippet}
					{#snippet ellipsis(count: number)}
						<Badge variant="outline" class="h-5 px-2 py-0">
							<span class="text-xs">+{count}</span>
						</Badge>
					{/snippet}
				</AutoTruncator>
			{:else}
				{@render defaultLabel()}
			{/if}
		{:else if display}
			{@render display(value as TMultiple extends true ? T[] : T)}
		{:else}
			{@const option = options.find((candidate) => isEqual(candidate.value, value))}
			{#if option}
				{#if typeof option.label === 'string'}
					<span class={'truncate text-left text-xs'}>{option.label}</span>
				{:else}
					<div class={'truncate text-left text-xs'}>
						{@render option.label(
							value as T,
							(option.additionalLabelProps ?? {}) as TAdditionalProps
						)}
					</div>
				{/if}
			{:else}
				{@render defaultLabel()}
			{/if}
		{/if}
	</Track>
</Bound>
