<script lang="ts">
	import { resetInset } from '#lib/layout/inset.svelte';
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
	// An overlay is a new page edge: it does not inherit the page's inset owner.
	resetInset(true);
</script>

<Portal>
	<!-- repository-health:allow UI25 -- pass-through of the caller's `overlayClass` prop; its tokens are literal at the call site -->
	<Overlay class={overlayClass} />
	<DialogPrimitive.Content
		bind:ref
		data-mobile-bottom-sheet="true"
		style="--sheet-height: auto"
		class={cn(
			// repository-health:allow UI19 -- bits-ui owns the modal element (focus trap, dismissal); it is viewport-centred with translate and animates zoom/slide on the same transform, which Imposter's placement classes would fight
			// repository-health:allow UI6 -- the content box is the bits-ui element itself; consumers restyle its rhythm through `class` (`gap-0 p-0`), so its children cannot move into a nested primitive
			// repository-health:allow UI27 -- same bits-ui content box as UI6 above: `gap-4` is the overridable default rhythm of its direct children
			'fixed top-[50%] left-[50%] z-50 grid w-full origin-center translate-x-[-50%] translate-y-[-50%] gap-4 border bg-popover p-6 shadow-lg duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-1/2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-1/2 sm:rounded-lg',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<DialogPrimitive.Close
			class={cn(
				// repository-health:allow UI19 -- the close button stays a direct child of the bits-ui content so consumers can hide it with `[&>button]:hidden`; an Imposter wrapper would break that contract, and `as="button"` would drop the bits-ui Close dismissal wiring
				'absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-none focus:ring-inset disabled:pointer-events-none'
			)}
		>
			<Icon icon="lucide:x" class="size-4" />
			<span class="sr-only">{t('common.close')}</span>
		</DialogPrimitive.Close>
	</DialogPrimitive.Content>
</Portal>
