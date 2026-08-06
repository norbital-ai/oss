<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { Dialog as DialogPrimitive, Portal, type WithoutChildrenOrChild } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import Overlay from './dialog-overlay.svelte';

	const { t } = useI18n<UiKeys>();

	let {
		ref = $bindable(null),
		class: className,
		overlayClass,
		children,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		children: Snippet;
		overlayClass?: string;
	} = $props();
</script>

<Portal>
	<Overlay class={overlayClass} />
	<DialogPrimitive.Content
		bind:ref
		class={cn(
			'fixed top-[50%] left-[50%] z-50 grid w-full origin-center translate-x-[-50%] translate-y-[-50%] gap-4 border bg-popover p-6 shadow-lg duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-1/2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-1/2 sm:rounded-lg',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<DialogPrimitive.Close
			class="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-none focus:ring-inset disabled:pointer-events-none"
		>
			<Icon icon="lucide:x" class="size-4" />
			<span class="sr-only">{t('common.close')}</span>
		</DialogPrimitive.Close>
	</DialogPrimitive.Content>
</Portal>
