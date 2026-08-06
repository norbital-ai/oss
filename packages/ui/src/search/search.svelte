<!-- SearchPopover.svelte -->
<script lang="ts" module>
	export interface SearchProps {
		onValueChange?: (value: string) => void;
		onCommit?: (value: string) => void;
		onDismiss?: () => void;
		value: string;
		/** Shown on the trigger indicator when set; defaults to `value`. */
		appliedValue?: string;
		placeholder?: string;
		indicatorVariant?: 'default' | 'success' | 'warning' | 'error' | 'info';
		indicatorSize?: 'sm' | 'md' | 'lg';
		indicatorPosition?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
		indicatorAnimated?: boolean;
		showIndicator?: boolean;
		disabled?: boolean;
		/** When false, closing the popover without Enter reverts draft input via `onDismiss`. */
		commitOnClose?: boolean;
	}
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import { Indicator } from '#lib/indicator';
	import { Input } from '#lib/input';
	import * as Popover from '#lib/popover';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';

	const { t } = useI18n<UiKeys>();

	let {
		onValueChange,
		onCommit,
		onDismiss,
		value = $bindable(),
		appliedValue,
		placeholder = t('misc.searchEllipsis'),
		indicatorVariant = 'default',
		indicatorSize = 'md',
		indicatorPosition = 'top-right',
		indicatorAnimated = true,
		showIndicator = true,
		disabled = false,
		commitOnClose = true
	}: SearchProps = $props();

	let isSearchOpen = $state(false);
	let searchInput: HTMLInputElement | null = $state(null);

	const indicatorValue = $derived(appliedValue ?? value);
	const showQueryIndicator = $derived(
		showIndicator && !isSearchOpen && !!indicatorValue && indicatorValue.trim() !== ''
	);

	function commitSearch() {
		onCommit?.(value);
	}
</script>

<div class="relative flex items-center">
	<Popover.Root
		bind:open={isSearchOpen}
		onOpenChange={(open) => {
			if (open) return;
			if (commitOnClose) {
				commitSearch();
				return;
			}
			onDismiss?.();
		}}
	>
		<Indicator
			variant={indicatorVariant}
			size={indicatorSize}
			position={indicatorPosition}
			animated={indicatorAnimated}
			visible={showQueryIndicator}
		>
			<Popover.Trigger
				class={cn(
					buttonVariants({
						variant: 'ghost',
						size: 'icon'
					})
				)}
			>
				<Icon icon="lucide:search" class="h-4 w-4" />
			</Popover.Trigger>
		</Indicator>
		<Popover.Content side="right" align="center" sideOffset={5} class="m-0 w-full p-0">
			<Input
				type="text"
				{placeholder}
				bind:value
				bind:ref={searchInput}
				oninput={() => {
					onValueChange?.(value);
				}}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						isSearchOpen = false;
						commitSearch();
					}
				}}
				class="h-6 min-w-32 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
				{disabled}
			/>
		</Popover.Content>
	</Popover.Root>
</div>
