<script lang="ts">
	import { reset_inset } from '../../layout/inset.svelte.js';
	import Icon from '@iconify/svelte';
	import { ui_text, cn } from '../utils.js';
	import type { ComponentProps, Snippet } from 'svelte';
	import { watchKeyboard } from '../sheet/keyboard.js';
	import Close from './dialog-close.svelte';
	import Overlay from './dialog-overlay.svelte';
	import Portal from './dialog-portal.svelte';
	import PrimitiveContent from './dialog-primitive-content.svelte';

	const t = ui_text();
	let {
		ref = $bindable(null),
		class: className,
		overlay_class,
		children,
		...restProps
	}: Omit<ComponentProps<typeof PrimitiveContent>, 'children'> & {
		/** Dialog body content. */
		children: Snippet;
		/** Extra classes on the backdrop overlay. */
		overlay_class?: string;
	} = $props();
	reset_inset(true);
	watchKeyboard();
</script>

<Portal>
	<!-- repository-health:allow UI25 -- pass-through of the caller's `overlay_class` prop; its tokens are literal at the call site -->
	<Overlay class={overlay_class} />
	<PrimitiveContent
		bind:ref
		data-mobile-bottom-sheet="true"
		style="--sheet-height: auto"
		class={cn(
			// repository-health:allow UI19 -- modal dialog owns viewport-centred placement and center-origin scale motion
			// repository-health:allow UI6 -- consumers restyle rhythm through `class` (`gap-0 p-0`) on the content box itself
			// repository-health:allow UI27 -- `gap-4` is the overridable default rhythm of direct children
			'fixed top-[50%] left-[50%] z-50 grid w-full origin-center translate-x-[-50%] translate-y-[-50%] gap-4 border bg-popover p-6 shadow-deep animation-duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:rounded-overlay',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<Close
			class={cn(
				// repository-health:allow UI19 -- direct child so consumers can hide it with `[&>button]:hidden`
				'absolute top-4 right-4 rounded-control opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-none focus:ring-inset disabled:pointer-events-none'
			)}
		>
			<Icon icon="lucide:x" class="size-4" />
			<span class="sr-only">{t('close')}</span>
		</Close>
	</PrimitiveContent>
</Portal>
