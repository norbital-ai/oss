// Live semantic UI control registry: lets built-in `@norbital-ai/ui` components AND custom
// tenant primitives expose their live state and typed semantic actions to Norbius's `page` bridge
// without brittle DOM scraping or CSS selectors.

/** Semantic action callback registered on a live UI control. */
export type ControlAction = (...args: readonly unknown[]) => void;

/** Registration descriptor for a live interactive UI control. */
export type ControlDescriptor = {
	/** Stable semantic identifier, e.g. `'tabs:settings'` or `'accordion:law_changes'`. */
	readonly id: string;
	/** Component kind, e.g. `'tabs'`, `'tab-strip'`, `'accordion'`, `'disclosure'`, `'selection'`. */
	readonly kind: string;
	/** Optional human-readable label. */
	readonly label?: string;
	/** Live snapshot of state (active tab, open state, selected count, items, etc.). */
	readonly state: () => Record<string, unknown>;
	/** Named semantic actions callable by the host/agent bridge. */
	readonly actions?: Readonly<Record<string, ControlAction>>;
};

/** Read-only snapshot of a registered UI control's current state and actions. */
export type ControlSnapshot = {
	readonly id: string;
	readonly kind: string;
	readonly label?: string;
	readonly state: Record<string, unknown>;
	readonly actions: readonly string[];
};

const registry = new Map<string, ControlDescriptor>();

/**
 * Registers a live UI control while mounted and returns its cleanup function.
 * Designed for use inside `$effect` or Svelte attachments (`{@attach ...}`).
 * @example
 * $effect(() => register_control({
 *   id: 'workbench:queue',
 *   kind: 'listbox',
 *   label: 'Triage queue',
 *   state: () => ({ active: activeId, selected: selection.selected }),
 *   actions: { select: (id) => { if (typeof id === 'string') activeId = id; } }
 * }));
 */
export function register_control(descriptor: ControlDescriptor): () => void {
	registry.set(descriptor.id, descriptor);
	return () => {
		if (registry.get(descriptor.id) === descriptor) {
			registry.delete(descriptor.id);
		}
	};
}

/** Returns a deterministic snapshot of every registered live UI control on the current page. */
export function page_controls(): ControlSnapshot[] {
	return [...registry.values()].map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		...(entry.label !== undefined ? { label: entry.label } : {}),
		state: entry.state(),
		actions: Object.keys(entry.actions ?? {})
	}));
}

/** Invokes a named semantic action on a registered control by id; returns whether it ran. */
export function act_on_control(
	id: string,
	action: string,
	args: readonly unknown[] = []
): boolean {
	const entry = registry.get(id);
	const fn = entry?.actions?.[action];
	if (typeof fn !== 'function') return false;
	fn(...args);
	return true;
}

/** Concise one-line summary of registered controls for Norbius's `pageScreen()` context. */
export function describe_controls(): string {
	const items = page_controls();
	if (items.length === 0) return '';
	return items
		.map((c) => {
			const summary = Object.entries(c.state)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : String(v)}`)
				.join(' ');
			return `${c.kind}:${c.label ?? c.id}${summary ? `(${summary})` : ''}`;
		})
		.join(' · ');
}
