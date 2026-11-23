// Declarative keyboard shortcut bindings (`mod+k`, `shift+escape`, `alt+n`, etc.).
// Automatically skips editable inputs unless `allow_in_input: true`.

/** One declarative keyboard shortcut binding for `create_shortcuts`. */
export type ShortcutBinding = {
	/** Shortcut spec such as `'mod+k'`, `'escape'`, `'shift+alt+p'`, `'/'`. */
	readonly keys: string;
	/** Handler invoked when matched. */
	readonly handler: (event: KeyboardEvent) => void;
	/** Allow firing while focus is inside an input, textarea, select or contenteditable (default `false`). */
	readonly allow_in_input?: boolean;
	/** Call `event.preventDefault()` on match (default `true`). */
	readonly prevent_default?: boolean;
	/** Temporarily disable this shortcut. */
	readonly enabled?: boolean | (() => boolean);
};

type ParsedShortcut = {
	mod: boolean;
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
	shift: boolean;
	key: string;
};

function parseShortcut(spec: string): ParsedShortcut {
	const parts = spec
		.toLowerCase()
		.split('+')
		.map((part) => part.trim())
		.filter((part) => part !== '');
	const key = parts.at(-1) ?? '';
	const mods = new Set(parts.slice(0, -1));
	return {
		mod: mods.has('mod') || mods.has('cmdorctrl'),
		ctrl: mods.has('ctrl') || mods.has('control'),
		meta: mods.has('meta') || mods.has('cmd') || mods.has('command'),
		alt: mods.has('alt') || mods.has('option'),
		shift: mods.has('shift'),
		key
	};
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Returns whether `event` matches a shortcut string such as `'mod+k'` or `'shift+escape'`. */
export function matches_shortcut(event: KeyboardEvent, spec: string): boolean {
	const parsed = parseShortcut(spec);
	if (parsed.key === '') return false;
	if (event.key.toLowerCase() !== parsed.key) return false;
	if (parsed.mod) {
		if (!(event.metaKey || event.ctrlKey)) return false;
	} else {
		if (event.ctrlKey !== parsed.ctrl) return false;
		if (event.metaKey !== parsed.meta) return false;
	}
	if (event.altKey !== parsed.alt) return false;
	if (event.shiftKey !== parsed.shift) return false;
	return true;
}

/**
 * Binds one or more keyboard shortcuts while mounted (cleaned up automatically when the enclosing
 * component tears down).
 * @example
 * create_shortcuts([
 *   { keys: 'j', handler: () => moveSelection(1) },
 *   { keys: 'k', handler: () => moveSelection(-1) },
 *   { keys: 'mod+k', allow_in_input: true, handler: () => (paletteOpen = true) }
 * ]);
 */
export function create_shortcuts(
	bindings: readonly ShortcutBinding[] | (() => readonly ShortcutBinding[]),
	options: { target?: () => EventTarget | null } = {}
): void {
	$effect(() => {
		const target = options.target ? options.target() : typeof window !== 'undefined' ? window : null;
		if (target === null) return;
		const list = typeof bindings === 'function' ? bindings() : bindings;

		const listener = (raw: Event) => {
			if (!(raw instanceof KeyboardEvent) || raw.defaultPrevented || raw.isComposing) return;
			for (const binding of list) {
				const on =
					typeof binding.enabled === 'function' ? binding.enabled() : (binding.enabled ?? true);
				if (!on) continue;
				if (!binding.allow_in_input && isEditableTarget(raw.target)) continue;
				if (!matches_shortcut(raw, binding.keys)) continue;
				if (binding.prevent_default !== false) raw.preventDefault();
				binding.handler(raw);
				return;
			}
		};

		target.addEventListener('keydown', listener);
		return () => target.removeEventListener('keydown', listener);
	});
}
