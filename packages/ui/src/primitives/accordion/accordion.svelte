<script lang="ts" module>
	let nextId = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { register_control } from '../../behaviors/index.js';
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
		...modeAndRest
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> &
		(SingleProps | MultipleProps) & {
			/** Disables every item in the accordion. */
			disabled?: boolean;
			/** Accordion items. */
			children?: Snippet;
		} = $props();

	const prefix = `nb-accordion-${++nextId}`;

	const is_open = (item: string): boolean => {
		if (modeAndRest.type === 'multiple') return Array.isArray(value) && value.includes(item);
		return typeof value === 'string' && value === item;
	};

	function toggle(item: string): void {
		if (disabled) return;
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
		}
	});

	$effect(() =>
		register_control({
			id: `accordion:${prefix}`,
			kind: 'accordion',
			state: () => ({
				open: Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : []
			}),
			actions: {
				toggle: (item) => {
					if (typeof item === 'string') toggle(item);
				}
			}
		})
	);
</script>

<div bind:this={ref} data-slot="accordion" data-orientation="vertical" {...restProps}>
	{@render children?.()}
</div>
