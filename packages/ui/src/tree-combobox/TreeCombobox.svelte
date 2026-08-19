<script lang="ts" generics="TMetadata">
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import * as Popover from '#lib/popover';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { BaseTreeItem } from '#lib/tree-select';
	import { TreeSelect } from '#lib/tree-select';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';

	const { t } = useI18n<UiKeys>();

	let {
		rootItems = [] as readonly BaseTreeItem<TMetadata>[],
		value = '' as string | undefined,
		placeholder = t('misc.selectEllipsis'),
		readonly = false,
		disabled = false,
		disabledIds = [] as string[],
		onValueChange,
		searchPlaceholder = t('misc.searchEllipsis'),
		ariaLabel,
		align = 'start' as 'start' | 'center' | 'end',
		contentClass = '',
		triggerClass = '',
		trigger,
		allowCleared = true
	}: {
		trigger?: Snippet<[{ displayLabel: string | null }]>;
		rootItems: readonly BaseTreeItem<TMetadata>[];
		value?: string;
		placeholder?: string;
		readonly?: boolean;
		disabled?: boolean;
		disabledIds?: string[];
		onValueChange?: (val: string | undefined) => void;
		searchPlaceholder?: string;
		ariaLabel?: string;
		align?: 'start' | 'center' | 'end';
		contentClass?: string;
		triggerClass?: string;
		allowCleared?: boolean;
	} = $props();

	let open = $state(false);
	const compactTextClass = 'text-xs';

	const displayLabel = $derived.by(() => {
		if (!value) return null;
		const stack = rootItems.map((item) => ({ item, path: [item.title] }));
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) break;
			if (current.item.id === value) {
				const path = rootItems.length === 1 ? current.path.slice(1) : current.path;
				return path.join(' / ');
			}
			for (const child of current.item.children ?? []) {
				stack.push({ item: child, path: [...current.path, child.title] });
			}
		}
		return null;
	});
	function handleClear(event: Event) {
		if (readonly || disabled) return;
		event.stopPropagation();
		value = undefined;
		open = false;
		onValueChange?.(value);
	}
</script>

<Popover.Root bind:open>
	<div class="group relative w-full">
		<Popover.Trigger
			aria-expanded={open}
			aria-haspopup="tree"
			aria-label={ariaLabel}
			class={cn(
				'flex h-8 w-full items-center gap-2 rounded border border-input bg-background p-1 pl-2 text-left shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset',
				triggerClass,
				{
					'cursor-default': readonly,
					'cursor-not-allowed opacity-60': disabled
				}
			)}
			{disabled}
		>
			{#if trigger}
				{@render trigger({ displayLabel })}
			{:else if displayLabel}
				<span class="truncate text-xs">{displayLabel}</span>
			{:else}
				<span class="text-meta">{placeholder}</span>
			{/if}
		</Popover.Trigger>
		{#if !readonly && !disabled}
			<div
				class="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center"
			>
				{#if allowCleared && value}
					<button
						type="button"
						class={cn(
							buttonVariants({ variant: 'outline' }),
							'pointer-events-auto h-4 w-min flex-none px-1 py-0 text-muted-foreground opacity-0 transition-opacity',
							'group-hover:opacity-100 group-focus-within:opacity-100',
							compactTextClass
						)}
						onclick={(e) => {
							e.preventDefault();
							handleClear(e);
						}}
						aria-label={t('dataRenderer.clearSelection')}>{t('misc.clearButton')}</button
					>
				{:else}
					<Icon
						icon="lucide:chevrons-up-down"
						class="h-3 w-3 shrink-0 opacity-50"
						aria-hidden="true"
					/>
				{/if}
			</div>
		{/if}
	</div>
	<Popover.Content
		{align}
		sideOffset={4}
		class={cn('w-[min(calc(100vw-2rem),28rem)] min-w-0 max-w-[calc(100vw-2rem)] p-1', contentClass)}
	>
		<TreeSelect
			multiple={false}
			showSearch={true}
			{searchPlaceholder}
			{rootItems}
			{disabled}
			{readonly}
			containerClass="h-[min(22rem,calc(100vh-8rem))]"
			value={{ selected: value ? [value] : [], disabled: disabledIds }}
			onChange={(vals) => {
				const selected = vals.selected?.[0];
				if (selected) {
					onValueChange?.(selected);
					open = false;
				}
			}}
		/>
	</Popover.Content>
</Popover.Root>
