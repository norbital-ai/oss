<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { SnakeProps } from '../bits.js';
	let {
		ref = $bindable(null),
		on_open_auto_focus,
		on_close_auto_focus,
		trap_focus,
		on_interact_outside,
		interact_outside_behavior,
		on_focus_outside,
		on_escape_keydown,
		escape_keydown_behavior,
		force_mount,
		prevent_overflow_text_selection,
		prevent_scroll,
		restore_scroll_delay,
		...rest
	}: SnakeProps<Dialog.ContentProps, {
		on_open_auto_focus: 'onOpenAutoFocus';
		on_close_auto_focus: 'onCloseAutoFocus';
		trap_focus: 'trapFocus';
		on_interact_outside: 'onInteractOutside';
		interact_outside_behavior: 'interactOutsideBehavior';
		on_focus_outside: 'onFocusOutside';
		on_escape_keydown: 'onEscapeKeydown';
		escape_keydown_behavior: 'escapeKeydownBehavior';
		force_mount: 'forceMount';
		prevent_overflow_text_selection: 'preventOverflowTextSelection';
		prevent_scroll: 'preventScroll';
		restore_scroll_delay: 'restoreScrollDelay';
	}> = $props();
	const native = $derived.by(() => {
		const props: Omit<Dialog.ContentProps, 'ref'> = { ...rest };
		if (on_open_auto_focus !== undefined) props.onOpenAutoFocus = on_open_auto_focus;
		if (on_close_auto_focus !== undefined) props.onCloseAutoFocus = on_close_auto_focus;
		if (trap_focus !== undefined) props.trapFocus = trap_focus;
		if (on_interact_outside !== undefined) props.onInteractOutside = on_interact_outside;
		if (interact_outside_behavior !== undefined)
			props.interactOutsideBehavior = interact_outside_behavior;
		if (on_focus_outside !== undefined) props.onFocusOutside = on_focus_outside;
		if (on_escape_keydown !== undefined) props.onEscapeKeydown = on_escape_keydown;
		if (escape_keydown_behavior !== undefined)
			props.escapeKeydownBehavior = escape_keydown_behavior;
		if (force_mount !== undefined) props.forceMount = force_mount;
		if (prevent_overflow_text_selection !== undefined)
			props.preventOverflowTextSelection = prevent_overflow_text_selection;
		if (prevent_scroll !== undefined) props.preventScroll = prevent_scroll;
		if (restore_scroll_delay !== undefined) props.restoreScrollDelay = restore_scroll_delay;
		return props;
	});
</script>

<Dialog.Content bind:ref {...native} />
