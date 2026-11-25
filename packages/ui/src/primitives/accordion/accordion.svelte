<script lang="ts" module>
	let nextId = 0;
</script>

<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { create_roving_focus, register_control } from '../../behaviors/index.js';
	import type { WithElementRef } from '../utils.js';
	import { set_accordion_root } from './context.js';

	type SingleProps = {
		/** Single-section mode (at most one item open at a time). */
		type: 'single';
		/** Currently open item key; bindable. */
		value?: string;
		/** Called when the open item key changes. */
		on_value_change?: (value: string) => void;
	};
	type MultipleProps = {
		/** Multi-section mode (any number of items open concurrently). */
		type: 'multiple';
		/** Currently open item keys; bindable. */
		value?: string[];
		/** Called when the open item keys change. */
		on_value_change?: (value: string[]) => void;
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		disabled = false,
		children,
		onkeydown,
		...modeAndRest
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> &
		(SingleProps | MultipleProps) & {
			/** Disables every item in the accordion. */
			disabled?: boolean;
			/** Accordion items. */
			children?: Snippet;
		} = $props();

	const prefix = `nb-accordion-${++nextId}`;
	let registeredItems = $state<readonly string[]>([]);
	const itemDisabled = new Map<string, () => boolean>();

	const is_open = (item: string): boolean => {
		if (modeAndRest.type === 'multiple') return Array.isArray(value) && value.includes(item);
		return typeof value === 'string' && value === item;
	};

	function toggle(item: string): void {
		if (disabled || itemDisabled.get(item)?.()) return;
		if (modeAndRest.type === 'multiple') {
			const cur = Array.isArray(value) ? value : [];
			const next = cur.includes(item) ? cur.filter((k) => k !== item) : [...cur, item];
			value = next;
			modeAndRest.on_value_change?.(next);
		} else {
			const next = value === item ? '' : item;
			value = next;
			modeAndRest.on_value_change?.(next);
		}
	}

	const roving = create_roving_focus({
		items: () => registeredItems,
		orientation: 'vertical',
		disabled: (key) => disabled || (itemDisabled.get(key)?.() ?? false)
	});

	const restProps = $derived.by(() => {
		const { type: _type, on_value_change: _cb, ...rest } = modeAndRest;
		return rest;
	});

	set_accordion_root({
		prefix,
		is_open,
		toggle,
		get disabled() {
			return disabled;
		},
		register_item(key, isOff) {
			itemDisabled.set(key, isOff);
			untrack(() => {
				if (!registeredItems.includes(key)) registeredItems = [...registeredItems, key];
			});
			return () => {
				itemDisabled.delete(key);
				untrack(() => {
					registeredItems = registeredItems.filter((k) => k !== key);
				});
			};
		},
		trigger_attachment: (key) => roving.item(key),
		on_trigger_focus: (key) => roving.item_attrs(key).onfocus()
	});

	$effect(() =>
		register_control({
			id: `accordion:${prefix}`,
			kind: 'accordion',
			element: () => ref,
			disabled: () => disabled,
			state: () => ({
				open: Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : [],
				items: registeredItems
			}),
			items: () => registeredItems.map((key) => ({ value: key, label: key })),
			actions: {
				toggle: (item) => {
					if (typeof item === 'string') toggle(item);
				}
			}
		})
	);
</script>

<div
	bind:this={ref}
	data-slot="accordion"
	data-orientation="vertical"
	{...restProps}
	onkeydown={(e) => {
		onkeydown?.(e);
		if (
			!e.defaultPrevented &&
			e.target instanceof Element &&
			e.target.closest('[data-slot="accordion-trigger"]') !== null
		) {
			roving.root_attrs().onkeydown(e);
		}
	}}
>
	{@render children?.()}
</div>
