<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createAttachmentKey } from 'svelte/attachments';
	import type { HTMLAttributes } from 'svelte/elements';
	import { create_dismiss, create_focus_trap } from '../../behaviors/index.js';
	import type { WithElementRef } from '../utils.js';
	import { get_dialog_context } from './context.js';

	let {
		ref = $bindable(null),
		on_open_auto_focus,
		on_close_auto_focus,
		trap_focus = true,
		on_interact_outside,
		interact_outside_behavior = 'close',
		on_focus_outside,
		on_escape_keydown,
		escape_keydown_behavior = 'close',
		force_mount = false,
		prevent_overflow_text_selection: _preventOverflow,
		prevent_scroll = true,
		restore_scroll_delay: _restoreScrollDelay,
		child,
		children,
		...rest
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLElement> & {
		/** Called before autofocus moves into the dialog on open; call `preventDefault()` to cancel. */
		on_open_auto_focus?: (event: Event) => void;
		/** Called before focus returns to the previous element on close; call `preventDefault()` to cancel. */
		on_close_auto_focus?: (event: Event) => void;
		/** Keep Tab cycling inside the dialog and mark background siblings inert (default `true`). */
		trap_focus?: boolean;
		/** Called on outside pointer interaction; call `preventDefault()` to keep open. */
		on_interact_outside?: (event: PointerEvent) => void;
		/** Outside pointer interaction mode (`'close'` | `'ignore'`, default `'close'`). */
		interact_outside_behavior?: 'close' | 'ignore' | 'defer-otherwise-close' | 'defer-otherwise-ignore';
		/** Called when focus moves outside the dialog while open. */
		on_focus_outside?: (event: FocusEvent) => void;
		/** Called on Escape key; call `preventDefault()` to keep open. */
		on_escape_keydown?: (event: KeyboardEvent) => void;
		/** Escape key behavior (`'close'` | `'ignore'`, default `'close'`). */
		escape_keydown_behavior?: 'close' | 'ignore' | 'defer-otherwise-close' | 'defer-otherwise-ignore';
		/** Keep element mounted while closed. */
		force_mount?: boolean;
		/** Kept for API ergonomics. */
		prevent_overflow_text_selection?: boolean;
		/** Ref-counted body scroll lock while open (default `true`). */
		prevent_scroll?: boolean;
		/** Optional scroll restore delay in ms. */
		restore_scroll_delay?: number | null;
		/** Optional render delegation snippet receiving dialog content props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Dialog body content. */
		children?: Snippet;
	} = $props();

	const dialog = get_dialog_context();
	const open = $derived(dialog?.open ?? false);
	let attachedEl = $state<HTMLElement | null>(null);
	const rootEl = $derived(ref ?? attachedEl);

	const dismiss = create_dismiss({
		open: () => open,
		escape: () =>
			escape_keydown_behavior !== 'ignore' &&
			escape_keydown_behavior !== 'defer-otherwise-ignore',
		outside: () =>
			interact_outside_behavior !== 'ignore' &&
			interact_outside_behavior !== 'defer-otherwise-ignore',
		on_dismiss: (reason, event) => {
			if (reason === 'escape' && event instanceof KeyboardEvent) {
				on_escape_keydown?.(event);
				if (!event.defaultPrevented) {
					event.preventDefault();
					dialog?.set_open(false);
				}
				return;
			}
			if (reason === 'outside' && event instanceof PointerEvent) {
				on_interact_outside?.(event);
				if (!event.defaultPrevented) dialog?.set_open(false);
			}
		}
	});

	const trap = create_focus_trap({
		active: () => open,
		trap: () => trap_focus,
		modal: () => trap_focus,
		prevent_scroll: () => prevent_scroll,
		topmost: () => dismiss.topmost,
		on_open_auto_focus: (event) => on_open_auto_focus?.(event),
		on_close_auto_focus: (event) => on_close_auto_focus?.(event),
		on_focus_outside: (event) => on_focus_outside?.(event)
	});

	$effect(() => {
		if (rootEl === null) return;
		const stopDismiss = dismiss.surface(rootEl);
		const stopTrap = trap.container(rootEl);
		return () => {
			stopTrap?.();
			stopDismiss?.();
		};
	});

	const childProps = $derived({
		[createAttachmentKey()]: (el: HTMLElement) => {
			attachedEl = el;
			return () => {
				if (attachedEl === el) attachedEl = null;
			};
		},
		role: dialog?.role ?? 'dialog',
		'aria-modal': trap_focus ? ('true' as const) : undefined,
		'aria-labelledby': dialog?.has_title ? dialog.title_id : undefined,
		'aria-describedby': dialog?.has_description ? dialog.description_id : undefined,
		'data-state': open ? ('open' as const) : ('closed' as const),
		tabindex: -1,
		...rest
	});
</script>

{#if open || force_mount}
	{#if child}
		{@render child({ props: childProps })}
	{:else}
		<div
			bind:this={ref}
			role={dialog?.role ?? 'dialog'}
			aria-modal={trap_focus ? 'true' : undefined}
			aria-labelledby={dialog?.has_title ? dialog.title_id : undefined}
			aria-describedby={dialog?.has_description ? dialog.description_id : undefined}
			data-state={open ? 'open' : 'closed'}
			tabindex="-1"
			{...rest}
		>
			{@render children?.()}
		</div>
	{/if}
{/if}
