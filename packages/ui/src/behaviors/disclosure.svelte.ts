// Composable disclosure behavior (expanded/collapsed state, ARIA attributes and optional external control).
// Used by built-in disclosures and exported for custom accordions, inline diffs and expandable detail panels.

let nextDisclosureId = 0;

/** Options for `create_disclosure`. */
export type DisclosureOptions = {
	/** Controlled open state; omit for internal state. */
	open?: () => boolean;
	/** Initial open state when uncontrolled (default `false`). */
	default_open?: boolean;
	/** Called whenever the disclosure opens or closes. */
	on_open_change?: (open: boolean) => void;
	/** Whether interaction is disabled. */
	disabled?: () => boolean;
	/** Stable id prefix for `aria-controls`; auto-generated when omitted. */
	id?: string;
};

/** Return value of `create_disclosure`. */
export type Disclosure = ReturnType<typeof create_disclosure>;

/**
 * Headless disclosure state + ARIA attribute getters (`trigger_attrs`, `content_attrs`).
 * Composes directly onto any button/panel without wrapper elements.
 */
export function create_disclosure(options: DisclosureOptions = {}) {
	const baseId = options.id ?? `nb-disclosure-${++nextDisclosureId}`;
	const contentId = `${baseId}-content`;
	let internal = $state(options.default_open ?? false);

	const open = $derived(options.open ? options.open() : internal);
	const disabled = $derived(options.disabled?.() ?? false);

	function set_open(next: boolean): void {
		if (disabled || next === open) return;
		if (!options.open) internal = next;
		options.on_open_change?.(next);
	}

	function toggle(): void {
		set_open(!open);
	}

	function show(): void {
		set_open(true);
	}

	function hide(): void {
		set_open(false);
	}

	return {
		get open() {
			return open;
		},
		get disabled() {
			return disabled;
		},
		get state(): 'open' | 'closed' {
			return open ? 'open' : 'closed';
		},
		set_open,
		toggle,
		show,
		hide,
		/** Spread onto the trigger button (`type`, `aria-expanded`, `aria-controls`, `data-state`, `disabled`, `onclick`). */
		trigger_attrs() {
			return {
				type: 'button' as const,
				'aria-expanded': open,
				'aria-controls': contentId,
				'data-state': open ? ('open' as const) : ('closed' as const),
				disabled: disabled || undefined,
				onclick: () => toggle()
			};
		},
		/** Spread onto the collapsible content element (`id`, `hidden`, `data-state`). */
		content_attrs() {
			return {
				id: contentId,
				hidden: !open,
				'data-state': open ? ('open' as const) : ('closed' as const)
			};
		}
	};
}
