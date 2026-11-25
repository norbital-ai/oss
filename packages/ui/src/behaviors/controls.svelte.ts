// Live semantic UI control registry, change provenance, observability stream and agent-scoped undo:
// lets built-in `@norbital-ai/ui` primitives AND custom tenant widgets expose live state, items,
// safety marks (`data-agent-confirm`, `data-agent-secret`, `data-agent-hidden`) and semantic actions
// to Norbius's `page` bridge without DOM scraping.

/** Who initiated a UI change. */
export type ChangeSource = 'pointer' | 'keyboard' | 'agent' | 'programmatic';

/** Semantic action callback registered on a live UI control. */
export type ControlAction = (...args: readonly unknown[]) => void;

/** Choice exposed by a selectable control (tabs, combobox, menu, radio group, tree). */
export type ControlChoice = { readonly value: string; readonly label: string };

/** Registration descriptor for a live interactive UI control. */
export type ControlDescriptor = {
	/** Stable semantic identifier, e.g. `'tabs:settings'` or `'combobox:status'`. */
	readonly id: string;
	/** Component kind, e.g. `'tabs'`, `'combobox'`, `'dialog'`, `'input'`, `'checkbox'`, `'menu'`. */
	readonly kind: string;
	/** Optional human-readable label (falls back to accessible name of `element`). */
	readonly label?: string;
	/** Optional root/interactive DOM element for scope filtering and `data-agent-*` marks. */
	readonly element?: () => HTMLElement | null | undefined;
	/** Live snapshot of state (active tab, open state, value, selected count, etc.). */
	readonly state: () => Record<string, unknown>;
	/** Optional choices accepted by selection actions. */
	readonly items?: () => readonly ControlChoice[];
	/** Named semantic actions callable by the host/agent bridge. */
	readonly actions?: Readonly<Record<string, ControlAction>>;
	/** Whether the control is currently disabled or read-only (hides callable actions). */
	readonly disabled?: () => boolean;
	/** Explicit confirmation prompt describing why a person must approve agent actions. */
	readonly confirm?: string | (() => string | undefined);
	/** Marks values as secret (writable by agent, always redacted in snapshots/observations). */
	readonly secret?: boolean | (() => boolean);
	/** Hides this control from agent snapshots and invocation. */
	readonly hidden?: boolean | (() => boolean);
};

/** Read-only snapshot of a registered UI control's current state, safety marks and actions. */
export type ControlSnapshot = {
	readonly id: string;
	readonly kind: string;
	readonly label?: string;
	readonly state: Record<string, unknown>;
	readonly actions: readonly string[];
	readonly items?: readonly ControlChoice[];
	readonly confirm?: string;
	readonly secret?: boolean;
	readonly disabled?: boolean;
};

/** Options for filtering `page_controls`. */
export type PageControlsOptions = {
	/** Only return controls whose `element()` sits inside this container. */
	readonly within?: Element | null;
	/** Optional substring filter over id, kind, or label. */
	readonly query?: string;
	/** Maximum number of controls to return. */
	readonly limit?: number;
};

/** Structured result returned by `invoke_control`. */
export type ControlInvokeResult = {
	readonly ok: boolean;
	readonly id?: string;
	readonly label?: string;
	readonly confirm?: string;
	readonly error?: string;
};

/** Emitted change record for `observe_controls` and `create_ui_history`. */
export type ControlChange = {
	readonly id: string;
	readonly kind: string;
	readonly label?: string;
	readonly key: string;
	readonly previous: unknown;
	readonly value: unknown;
	readonly source: ChangeSource;
	readonly reason: string;
	readonly redacted?: boolean;
	readonly committed: boolean;
};

const registry = new Map<string, ControlDescriptor>();
const observers = new Set<{
	readonly listener: (change: ControlChange) => void;
	readonly within?: Element | (() => Element | null | undefined);
	readonly live: boolean;
}>();

let activeSource: ChangeSource = 'programmatic';

/** Runs `fn` with `source` attributed to any UI control changes emitted synchronously inside it. */
export function with_source<T>(source: ChangeSource, fn: () => T): T {
	const prev = activeSource;
	activeSource = source;
	try {
		return fn();
	} finally {
		activeSource = prev;
	}
}

/** Returns the currently attributed change source (`'pointer' | 'keyboard' | 'agent' | 'programmatic'`). */
export function current_source(): ChangeSource {
	return activeSource;
}

function elementOf(entry: ControlDescriptor): HTMLElement | null {
	return entry.element?.() ?? null;
}

function isHidden(entry: ControlDescriptor): boolean {
	const explicit = typeof entry.hidden === 'function' ? entry.hidden() : entry.hidden;
	if (explicit === true) return true;
	const el = elementOf(entry);
	if (el === null) return false;
	return el.closest('[data-agent-hidden], [aria-hidden="true"]') !== null;
}

function isSecret(entry: ControlDescriptor): boolean {
	const explicit = typeof entry.secret === 'function' ? entry.secret() : entry.secret;
	if (explicit === true) return true;
	const el = elementOf(entry);
	if (el === null) return false;
	if (el instanceof HTMLInputElement && el.type === 'password') return true;
	return el.closest('[data-agent-secret]') !== null;
}

function confirmOf(entry: ControlDescriptor): string | undefined {
	const explicit = typeof entry.confirm === 'function' ? entry.confirm() : entry.confirm;
	if (explicit !== undefined && explicit !== '') return explicit;
	const el = elementOf(entry);
	if (el === null) return undefined;
	const marked = el.closest<HTMLElement>('[data-agent-confirm]');
	const text = marked?.getAttribute('data-agent-confirm')?.trim();
	return text !== undefined && text !== '' ? text : undefined;
}

function isDisabled(entry: ControlDescriptor): boolean {
	if (entry.disabled?.() === true) return true;
	const el = elementOf(entry);
	if (el === null) return false;
	return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

function labelOf(entry: ControlDescriptor): string | undefined {
	if (entry.label !== undefined && entry.label.trim() !== '') return entry.label.trim();
	const el = elementOf(entry);
	if (el === null) return undefined;
	const direct = el.getAttribute('aria-label')?.trim() || el.getAttribute('title')?.trim();
	if (direct) return direct;
	if ('labels' in el && el.labels instanceof NodeList && el.labels[0] instanceof HTMLElement) {
		const text = el.labels[0].textContent?.replace(/\s+/g, ' ').trim();
		if (text) return text;
	}
	const placeholder = el.getAttribute('placeholder')?.trim();
	if (placeholder) return placeholder;
	return undefined;
}

function redactState(state: Record<string, unknown>, secret: boolean): Record<string, unknown> {
	if (!secret) return state;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(state)) {
		out[k] = k === 'value' || k === 'text' ? '[redacted]' : v;
	}
	return out;
}

function snapshotEntry(entry: ControlDescriptor): ControlSnapshot {
	const secret = isSecret(entry);
	const disabled = isDisabled(entry);
	const confirm = confirmOf(entry);
	const label = labelOf(entry);
	const items = entry.items?.();
	return {
		id: entry.id,
		kind: entry.kind,
		...(label !== undefined ? { label } : {}),
		state: redactState(entry.state(), secret),
		actions: disabled ? [] : Object.keys(entry.actions ?? {}),
		...(items !== undefined && items.length > 0 ? { items: items.slice(0, 20) } : {}),
		...(confirm !== undefined ? { confirm } : {}),
		...(secret ? { secret: true } : {}),
		...(disabled ? { disabled: true } : {})
	};
}

/**
 * Registers a live UI control while mounted and returns its cleanup function.
 * Designed for use inside `$effect` or Svelte attachments (`{@attach ...}`).
 */
export function register_control(descriptor: ControlDescriptor): () => void {
	registry.set(descriptor.id, descriptor);
	return () => {
		if (registry.get(descriptor.id) === descriptor) {
			registry.delete(descriptor.id);
		}
	};
}

/** Emits a structured UI state change to every matching `observe_controls` listener. */
export function notify_control_change(change: {
	readonly id: string;
	readonly kind?: string;
	readonly label?: string;
	readonly key: string;
	readonly previous: unknown;
	readonly value: unknown;
	readonly reason?: string;
	readonly source?: ChangeSource;
	readonly committed?: boolean;
}): void {
	const entry = registry.get(change.id);
	const secret = entry !== undefined ? isSecret(entry) : false;
	const el = entry !== undefined ? elementOf(entry) : null;
	const committed = change.committed !== false;
	const event: ControlChange = {
		id: change.id,
		kind: change.kind ?? entry?.kind ?? 'control',
		...(change.label !== undefined
			? { label: change.label }
			: entry !== undefined && labelOf(entry) !== undefined
				? { label: labelOf(entry) }
				: {}),
		key: change.key,
		previous: secret ? '[redacted]' : change.previous,
		value: secret ? '[redacted]' : change.value,
		source: change.source ?? activeSource,
		reason: change.reason ?? 'change',
		...(secret ? { redacted: true } : {}),
		committed
	};

	for (const sub of observers) {
		if (!sub.live && !committed) continue;
		if (sub.within !== undefined) {
			const root = typeof sub.within === 'function' ? sub.within() : sub.within;
			if (root == null || el === null || !root.contains(el)) continue;
		}
		sub.listener(event);
	}
}

/** Subscribes to structured control state changes (settled commits by default; `live: true` for drag steps). */
export function observe_controls(
	listener: (change: ControlChange) => void,
	options: {
		readonly within?: Element | (() => Element | null | undefined);
		readonly live?: boolean;
	} = {}
): () => void {
	const sub = { listener, within: options.within, live: options.live === true };
	observers.add(sub);
	return () => observers.delete(sub);
}

/** Returns a deterministic snapshot of registered visible UI controls on the current page. */
export function page_controls(options: PageControlsOptions = {}): ControlSnapshot[] {
	const needle = options.query?.trim().toLowerCase() ?? '';
	const out: ControlSnapshot[] = [];
	for (const entry of registry.values()) {
		if (isHidden(entry)) continue;
		if (options.within !== undefined && options.within !== null) {
			const el = elementOf(entry);
			if (el === null || !options.within.contains(el)) continue;
		}
		const snap = snapshotEntry(entry);
		if (needle !== '') {
			const hay = `${snap.id} ${snap.kind} ${snap.label ?? ''}`.toLowerCase();
			if (!hay.includes(needle)) continue;
		}
		out.push(snap);
		if (options.limit !== undefined && out.length >= options.limit) break;
	}
	return out;
}

/** Resolves a registered control by exact `id`, exact label (case-insensitive), or unique label substring. */
export function resolve_control(
	ref: string,
	options: { readonly within?: Element | null } = {}
): { readonly entry: ControlDescriptor; readonly snapshot: ControlSnapshot } | { readonly error: string } {
	const needle = ref.trim().toLowerCase();
	if (needle === '') return { error: 'Empty control reference.' };

	const direct = registry.get(ref);
	if (direct !== undefined && !isHidden(direct)) {
		if (options.within == null || (elementOf(direct) !== null && options.within.contains(elementOf(direct)))) {
			return { entry: direct, snapshot: snapshotEntry(direct) };
		}
	}

	const candidates: { entry: ControlDescriptor; snapshot: ControlSnapshot; label: string }[] = [];
	for (const entry of registry.values()) {
		if (isHidden(entry)) continue;
		if (options.within != null) {
			const el = elementOf(entry);
			if (el === null || !options.within.contains(el)) continue;
		}
		const snapshot = snapshotEntry(entry);
		const label = (snapshot.label ?? '').toLowerCase();
		if (label !== '') candidates.push({ entry, snapshot, label });
	}

	const exact = candidates.filter((c) => c.label === needle);
	if (exact.length === 1 && exact[0] !== undefined) return exact[0];
	if (exact.length > 1) {
		return { error: `Ambiguous control "${ref}": ${exact.map((c) => c.entry.id).join(', ')}` };
	}

	const partial = candidates.filter((c) => c.label.includes(needle));
	if (partial.length === 1 && partial[0] !== undefined) return partial[0];
	if (partial.length > 1) {
		return { error: `Ambiguous control "${ref}": ${partial.map((c) => c.entry.id).join(', ')}` };
	}
	return { error: `No registered control matching "${ref}".` };
}

/**
 * Invokes a named semantic action on a registered control by `id` or accessible `label`, attributing
 * the change to `'agent'` and enforcing disabled/hidden/confirmation guards.
 */
export function invoke_control(
	ref: string,
	action: string,
	args: readonly unknown[] = [],
	options: { readonly within?: Element | null; readonly allow_confirm?: boolean } = {}
): ControlInvokeResult {
	const resolved = resolve_control(ref, options);
	if ('error' in resolved) return { ok: false, error: resolved.error };

	const { entry, snapshot } = resolved;
	if (snapshot.disabled) {
		return { ok: false, id: entry.id, label: snapshot.label, error: `Control "${snapshot.label ?? entry.id}" is disabled.` };
	}
	if (snapshot.confirm !== undefined && options.allow_confirm !== true) {
		return {
			ok: false,
			id: entry.id,
			label: snapshot.label,
			confirm: snapshot.confirm,
			error: `Needs confirmation: ${snapshot.confirm}`
		};
	}
	const fn = entry.actions?.[action];
	if (typeof fn !== 'function') {
		return {
			ok: false,
			id: entry.id,
			label: snapshot.label,
			error: `Action "${action}" is unavailable on "${snapshot.label ?? entry.id}" (available: ${snapshot.actions.join(', ') || 'none'}).`
		};
	}

	const before = entry.state();
	with_source('agent', () => fn(...args));
	const after = entry.state();
	for (const [key, value] of Object.entries(after)) {
		if (before[key] !== value) {
			notify_control_change({
				id: entry.id,
				kind: entry.kind,
				label: snapshot.label,
				key,
				previous: before[key],
				value,
				source: 'agent',
				reason: action
			});
		}
	}
	return { ok: true, id: entry.id, label: snapshot.label };
}

/** Invokes a named semantic action on a registered control by id or label; returns whether it ran. */
export function act_on_control(
	id: string,
	action: string,
	args: readonly unknown[] = []
): boolean {
	return invoke_control(id, action, args, { allow_confirm: true }).ok;
}

/** Concise one-line summary of registered controls for Norbius's `pageScreen()` context. */
export function describe_controls(options: PageControlsOptions = {}): string {
	const items = page_controls(options);
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

/** Recorded entry inside `create_ui_history`. */
export type UiHistoryEntry = ControlChange & {
	readonly seq: number;
	readonly reverted?: boolean;
};

/** Options for `create_ui_history`. */
export type UiHistoryOptions = {
	readonly within?: Element | (() => Element | null | undefined);
	/** Only record state keys in this list (defaults to all keys). */
	readonly keys?: readonly string[];
	/** Coalesce consecutive edits to the same `(id, key, source)` within 500ms (default `true`). */
	readonly coalesce?: boolean;
};

/** Return value of `create_ui_history`. */
export type UiHistory = ReturnType<typeof create_ui_history>;

function applyControlValue(id: string, key: string, value: unknown): boolean {
	const entry = registry.get(id);
	if (entry === undefined) return false;
	const actions = entry.actions ?? {};
	const direct = actions[`set_${key}`] ?? actions['set'] ?? actions['select'];
	if (typeof direct !== 'function') return false;
	with_source('programmatic', () => direct(value));
	return true;
}

/**
 * Records live control changes via `observe_controls` and supports stepping backward/forward or
 * reverting every non-redacted change made by one source (e.g. `history.undo_source('agent')`).
 */
export function create_ui_history(options: UiHistoryOptions = {}) {
	let entries = $state.raw<readonly UiHistoryEntry[]>([]);
	let position = $state(0);
	let seq = 0;
	let lastTime = 0;
	let restoring = false;

	const keyFilter = options.keys !== undefined ? new Set(options.keys) : null;
	const coalesce = options.coalesce !== false;

	const stop = observe_controls(
		(change) => {
			if (restoring) return;
			if (keyFilter !== null && !keyFilter.has(change.key)) return;
			const now = Date.now();
			const trimmed = entries.slice(0, position);
			const prev = trimmed.at(-1);
			if (
				coalesce &&
				prev !== undefined &&
				!prev.redacted &&
				!change.redacted &&
				prev.id === change.id &&
				prev.key === change.key &&
				prev.source === change.source &&
				now - lastTime <= 500
			) {
				entries = [...trimmed.slice(0, -1), { ...prev, value: change.value, reason: change.reason }];
			} else {
				entries = [...trimmed, { ...change, seq: ++seq }];
			}
			position = entries.length;
			lastTime = now;
		},
		{ within: options.within }
	);

	function undo(): boolean {
		if (position <= 0) return false;
		const target = entries[position - 1];
		if (target === undefined || target.redacted) return false;
		restoring = true;
		try {
			const ok = applyControlValue(target.id, target.key, target.previous);
			if (ok) position -= 1;
			return ok;
		} finally {
			restoring = false;
		}
	}

	function redo(): boolean {
		if (position >= entries.length) return false;
		const target = entries[position];
		if (target === undefined || target.redacted) return false;
		restoring = true;
		try {
			const ok = applyControlValue(target.id, target.key, target.value);
			if (ok) position += 1;
			return ok;
		} finally {
			restoring = false;
		}
	}

	function undo_source(source: ChangeSource): number {
		let revertedCount = 0;
		const next = [...entries];
		restoring = true;
		try {
			for (let i = position - 1; i >= 0; i--) {
				const item = next[i];
				if (item === undefined || item.source !== source || item.reverted || item.redacted) continue;
				if (applyControlValue(item.id, item.key, item.previous)) {
					next[i] = { ...item, reverted: true };
					revertedCount += 1;
				}
			}
			entries = next;
		} finally {
			restoring = false;
		}
		return revertedCount;
	}

	return {
		get entries() {
			return entries;
		},
		get position() {
			return position;
		},
		get can_undo() {
			return position > 0;
		},
		get can_redo() {
			return position < entries.length;
		},
		undo,
		redo,
		undo_source,
		destroy: stop
	};
}
