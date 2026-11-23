// Composable accordion behavior: single or multiple expanded items, optional collapse-all,
// roving keyboard focus across headers and live agent control registration.
import { register_control } from './controls.svelte.js';
import { create_roving_focus } from './roving-focus.svelte.js';

let nextAccordionId = 0;

/** Single or multiple expanded sections mode for `create_accordion`. */
export type AccordionMode = 'single' | 'multiple';

/** Options for `create_accordion`. */
export type AccordionOptions = {
	/** Item keys in visual order. */
	items: () => readonly string[];
	/** Single or multiple expanded sections (default `'single'`). */
	mode?: AccordionMode;
	/** In single mode, allow collapsing the only open item (default `true`). */
	collapsible?: boolean;
	/** Controlled open keys; omit for internal state. */
	open?: () => readonly string[];
	/** Initial open keys when uncontrolled. */
	default_open?: readonly string[];
	/** Called whenever expanded keys change. */
	on_change?: (open: readonly string[]) => void;
	/** Disabled predicate per item key. */
	disabled?: (key: string) => boolean;
	/** Optional semantic control id/label for Norbius's `page` bridge. */
	control?: { id: string; label?: string };
};

/** Return value of `create_accordion`. */
export type Accordion = ReturnType<typeof create_accordion>;

/**
 * Headless composable accordion built on `create_roving_focus` + `register_control`.
 */
export function create_accordion(options: AccordionOptions) {
	const prefix = `nb-acc-${++nextAccordionId}`;
	const mode = options.mode ?? 'single';
	const collapsible = options.collapsible ?? true;
	let internal = $state<readonly string[]>(options.default_open ?? []);

	const isDisabled = (key: string) => options.disabled?.(key) ?? false;
	const openKeys = $derived(options.open ? options.open() : internal);
	const openSet = $derived(new Set(openKeys));

	const roving = create_roving_focus({
		items: options.items,
		orientation: 'vertical',
		disabled: options.disabled
	});

	function commit(next: readonly string[]): void {
		if (!options.open) internal = next;
		options.on_change?.(next);
	}

	function toggle(key: string): void {
		if (isDisabled(key)) return;
		const isOpen = openSet.has(key);
		if (mode === 'single') {
			if (isOpen) {
				if (collapsible) commit([]);
			} else {
				commit([key]);
			}
			return;
		}
		commit(isOpen ? openKeys.filter((k) => k !== key) : [...openKeys, key]);
	}

	function expand(key: string): void {
		if (isDisabled(key) || openSet.has(key)) return;
		commit(mode === 'single' ? [key] : [...openKeys, key]);
	}

	function collapse(key: string): void {
		if (!openSet.has(key)) return;
		if (mode === 'single' && !collapsible) return;
		commit(openKeys.filter((k) => k !== key));
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'accordion',
				...(meta.label !== undefined ? { label: meta.label } : {}),
				state: () => ({ open: openKeys, items: options.items() }),
				actions: {
					toggle: (key) => {
						if (typeof key === 'string') toggle(key);
					},
					expand: (key) => {
						if (typeof key === 'string') expand(key);
					},
					collapse: (key) => {
						if (typeof key === 'string') collapse(key);
					}
				}
			})
		);
	}

	return {
		get open() {
			return openKeys;
		},
		is_open(key: string): boolean {
			return openSet.has(key);
		},
		toggle,
		expand,
		collapse,
		item: roving.item,
		root_attrs: roving.root_attrs,
		trigger_attrs(key: string) {
			const isOpen = openSet.has(key);
			const off = isDisabled(key);
			const rov = roving.item_attrs(key);
			return {
				type: 'button' as const,
				id: `${prefix}-trigger-${key}`,
				'aria-expanded': isOpen,
				'aria-controls': `${prefix}-panel-${key}`,
				'data-state': isOpen ? ('open' as const) : ('closed' as const),
				disabled: off || undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onclick: () => toggle(key)
			};
		},
		content_attrs(key: string) {
			const isOpen = openSet.has(key);
			return {
				id: `${prefix}-panel-${key}`,
				role: 'region' as const,
				'aria-labelledby': `${prefix}-trigger-${key}`,
				hidden: !isOpen,
				'data-state': isOpen ? ('open' as const) : ('closed' as const)
			};
		}
	};
}
