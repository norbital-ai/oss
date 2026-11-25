<script lang="ts" module>
	let nextPopoverId = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { set_popover_context, type PopoverHoverHandlers } from './context.js';

	let {
		open = $bindable(false),
		on_open_change,
		on_open_change_complete,
		children
	}: {
		/** Whether the popover is open; bindable. */
		open?: boolean;
		/** Called when open state changes. */
		on_open_change?: (open: boolean) => void;
		/** Called after open state settles. */
		on_open_change_complete?: (open: boolean) => void;
		/** Trigger and content of the popover. */
		children?: Snippet;
	} = $props();

	const content_id = `nb-popover-${++nextPopoverId}`;
	let triggerEl = $state<HTMLElement | null>(null);
	let contentEl = $state<HTMLElement | null>(null);
	let hoverHandlers: PopoverHoverHandlers | null = null;

	function set_open(next: boolean): void {
		if (next === open) return;
		open = next;
		on_open_change?.(next);
		queueMicrotask(() => on_open_change_complete?.(next));
	}

	set_popover_context({
		get open() {
			return open;
		},
		set_open,
		content_id,
		get trigger_el() {
			return triggerEl;
		},
		set_trigger: (el) => {
			triggerEl = el;
		},
		get content_el() {
			return contentEl;
		},
		set_content: (el) => {
			contentEl = el;
		},
		hover_enter: (event) => {
			hoverHandlers?.enter(event);
		},
		hover_leave: (event) => {
			hoverHandlers?.leave(event);
		},
		set_hover_handlers: (handlers) => {
			hoverHandlers = handlers;
		}
	});
</script>

{@render children?.()}
