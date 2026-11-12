<!--
@component
The mobile navigation drawer: a `Sheet` (the phone's bottom drawer, a left panel on a wide screen) that closes when
the route changes. It has no header: the navigation, flush to its edges in the sidebar's one tone, is the whole drawer.
-->
<script lang="ts" module>
	import type { SheetProps } from './sheet.svelte';

	/** The mobile nav drawer: a left `Sheet` that also closes on navigation. */
	export type DrawerProps = Omit<SheetProps, 'side'> & {
		/** The current route (pathname + search); the drawer closes when it changes. */
		path: string;
	};
</script>

<script lang="ts">
	import { watch } from 'runed';
	import { cn } from '../utils.js';
	import { navigates } from './dismiss.js';
	import Sheet from './sheet.svelte';

	let {
		open = $bindable(false),
		on_open_change,
		path,
		children,
		class: className,
		...rest
	}: DrawerProps = $props();
	const close = () => {
		open = false;
		on_open_change?.(false);
	};
	watch(
		() => path,
		() => close(),
		{ lazy: true }
	);
</script>

<!-- a phone: as tall as the navigation until dragged or expanded (not a fixed 90%), the grabber clear of the first row, and one safe-area inset (the nav's own footer pads it) -->
<Sheet
	bind:open
	{on_open_change}
	side="left"
	class={cn(
		'bg-sidebar [&:not([data-fullscreen])]:h-[var(--sheet-h,auto)] pt-5 pb-0 data-fullscreen:pt-[calc(1.25rem+env(safe-area-inset-top))] md:w-72 md:pt-0 [&>header]:hidden [&>[data-sheet-body]]:p-0',
		className
	)}
	{...rest}
>
	<!-- a tapped nav link closes the drawer even when the route does not change -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="contents" onclick={(e) => navigates(e) && close()}>{@render children()}</div>
</Sheet>
