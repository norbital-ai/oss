<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import {
		create_floating,
		portal,
		type FloatingAlign,
		type FloatingSide,
		type PortalTarget
	} from '../../behaviors/index.js';
	import { Stack } from '../../layout/index.js';
	import { reset_inset } from '../../layout/inset.svelte.js';
	import { cn, type WithElementRef } from '../utils.js';
	import { get_popover_context } from './context.js';

	let {
		ref = $bindable(null),
		class: className,
		side = 'bottom',
		side_offset = 4,
		align = 'center',
		align_offset = 0,
		avoid_collisions = true,
		collision_padding = 8,
		portal_props,
		same_width = false,
		min_width,
		max_width,
		style = '',
		custom_anchor,
		on_open_auto_focus,
		on_close_auto_focus = (e) => e.preventDefault(),
		trap_focus: _trapFocus,
		on_interact_outside,
		interact_outside_behavior = 'close',
		on_focus_outside: _onFocusOutside,
		on_escape_keydown,
		escape_keydown_behavior = 'close',
		force_mount = false,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLElement> & {
		/** Preferred side of the anchor (default `'bottom'`). */
		side?: FloatingSide;
		/** Gap from the anchor in px (default `4`). */
		side_offset?: number;
		/** Cross-axis alignment relative to the anchor (default `'center'`). */
		align?: FloatingAlign;
		/** Shift along the cross axis in px. */
		align_offset?: number;
		/** Flip/shift to stay inside viewport bounds (default `true`). */
		avoid_collisions?: boolean;
		/** Viewport edge gutter in px (default `8`). */
		collision_padding?: number;
		/** Portal target configuration (`{ to?, disabled? }`). */
		portal_props?: { to?: PortalTarget; disabled?: boolean };
		/** Match the trigger's exact width. */
		same_width?: boolean;
		/** Minimum width in pixels. */
		min_width?: number;
		/** Maximum width in pixels. */
		max_width?: number;
		/** Extra inline styles. */
		style?: string;
		/** Alternate anchor element instead of the trigger. */
		custom_anchor?: HTMLElement | null;
		/** Hook before opening autofocus. */
		on_open_auto_focus?: (event: Event) => void;
		/** Hook before closing focus restoration. */
		on_close_auto_focus?: (event: Event) => void;
		/** Unused kept for ergonomic parity. */
		trap_focus?: boolean;
		/** Called on outside pointer interaction. */
		on_interact_outside?: (event: Event) => void;
		/** Outside interaction mode. */
		interact_outside_behavior?: 'close' | 'ignore' | 'defer-otherwise-close' | 'defer-otherwise-ignore';
		/** Focus outside hook. */
		on_focus_outside?: (event: FocusEvent) => void;
		/** Escape keydown hook. */
		on_escape_keydown?: (event: KeyboardEvent) => void;
		/** Escape key behavior. */
		escape_keydown_behavior?: 'close' | 'ignore' | 'defer-otherwise-close' | 'defer-otherwise-ignore';
		/** Keep mounted while closed. */
		force_mount?: boolean;
		/** Popover body content. */
		children: Snippet;
	} = $props();

	reset_inset(true);
	const popover = get_popover_context();
	const open = $derived(popover?.open ?? false);

	const floating = create_floating({
		open: () => open,
		side: () => side,
		align: () => align,
		side_offset: () => side_offset,
		align_offset: () => align_offset,
		padding: () => collision_padding,
		flip: () => avoid_collisions,
		escape: () =>
			escape_keydown_behavior !== 'ignore' &&
			escape_keydown_behavior !== 'defer-otherwise-ignore',
		outside: () =>
			interact_outside_behavior !== 'ignore' &&
			interact_outside_behavior !== 'defer-otherwise-ignore',
		on_dismiss: (reason) => {
			if (reason === 'escape' && on_escape_keydown) {
				const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
				on_escape_keydown(ev);
				if (ev.defaultPrevented) return;
			}
			if (reason === 'outside' && on_interact_outside) {
				const ev = new CustomEvent('popover.interactOutside', { cancelable: true });
				on_interact_outside(ev);
				if (ev.defaultPrevented) return;
			}
			popover?.set_open(false);
		}
	});

	$effect(() => {
		floating.set_anchor(custom_anchor ?? popover?.trigger_el ?? null);
	});

	$effect(() => {
		if (!open) return;
		const trigger = popover?.trigger_el ?? null;
		const openEv = new CustomEvent('popover.openAutoFocus', { cancelable: true });
		on_open_auto_focus?.(openEv);
		return () => {
			const closeEv = new CustomEvent('popover.closeAutoFocus', { cancelable: true });
			on_close_auto_focus?.(closeEv);
			if (!closeEv.defaultPrevented && trigger !== null && trigger.isConnected) {
				trigger.focus({ preventScroll: true });
			}
		};
	});

	const constrainedWidthStyle = $derived.by(() => {
		if (!min_width && !max_width && !same_width) return '';
		const availableWidth = 'calc(100vw - 1rem)';
		const parts = [same_width ? 'width: var(--anchor-width);' : 'width: max-content;'];
		if (min_width) parts.push(`min-width: ${min_width}px;`);
		parts.push(
			`max-width: ${max_width ? `min(${max_width}px, ${availableWidth})` : availableWidth};`
		);
		return parts.join(' ');
	});

	const needsWidthConstraints = $derived(Boolean(min_width || max_width || same_width));
	const combinedStyle = $derived(
		[floating.style, constrainedWidthStyle, style].filter(Boolean).join(' ')
	);
</script>

{#if open || force_mount}
	<div
		{@attach portal(portal_props?.disabled ? null : portal_props?.to)}
		class="contents"
		data-popover-portal
	>
		<div
			bind:this={ref}
			id={popover?.content_id}
			{@attach floating.content}
			data-slot="popover-content"
			data-state={open ? 'open' : 'closed'}
			data-side={floating.side}
			style={combinedStyle}
			class={cn(
				'z-50 max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain rounded-control border bg-popover text-popover-foreground shadow-deep outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
				needsWidthConstraints ? '' : 'p-4',
				needsWidthConstraints ? '' : className
			)}
			{...restProps}
		>
			{#if needsWidthConstraints}
				<Stack gap="none" class={cn('p-4', className)}>
					{@render children()}
				</Stack>
			{:else}
				{@render children()}
			{/if}
		</div>
	</div>
{/if}
