// Declarative keyboard shortcut bindings (`mod+k`, `shift+escape`, `g i` chord sequences, etc.).
// Automatically skips editable inputs unless `allow_in_input: true`, plus `aria_keyshortcuts`
// and OS-aware `format_shortcut` display helpers.

/** One declarative keyboard shortcut binding for `create_shortcuts`. */
export type ShortcutBinding = {
	/** Shortcut spec such as `'mod+k'`, `'escape'`, `'shift+alt+p'`, `'/'`, or chord `'g i'`. */
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
	readonly mod: boolean;
	readonly ctrl: boolean;
	readonly meta: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly key: string;
};

function parseChordStep(step: string): ParsedShortcut {
	const parts = step
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

function parseSequence(spec: string): ParsedShortcut[] {
	return spec
		.trim()
		.split(/\s+/)
		.filter((part) => part !== '')
		.map(parseChordStep);
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function matchesStep(event: KeyboardEvent, parsed: ParsedShortcut, strictPlatform = false): boolean {
	if (parsed.key === '') return false;
	const eventKey = event.key === ' ' ? 'space' : event.key.toLowerCase();
	if (eventKey !== parsed.key) return false;
	if (parsed.mod) {
		if (strictPlatform) {
			const mac = isMacPlatform();
			if (mac ? !(event.metaKey && !event.ctrlKey) : !(event.ctrlKey && !event.metaKey)) return false;
		} else if (!(event.metaKey || event.ctrlKey)) {
			return false;
		}
	} else {
		if (event.ctrlKey !== parsed.ctrl) return false;
		if (event.metaKey !== parsed.meta) return false;
	}
	if (event.altKey !== parsed.alt) return false;
	if (event.shiftKey !== parsed.shift) return false;
	return true;
}

/** Options for `matches_shortcut`. */
export type MatchShortcutOptions = {
	/** When `true`, `'mod'` only matches `Meta` on Apple platforms and `Control` elsewhere (default `false`). */
	readonly strict_platform?: boolean;
};

/** Returns whether `event` matches a single-step shortcut string such as `'mod+k'` or `'shift+escape'`. */
export function matches_shortcut(
	event: KeyboardEvent,
	spec: string,
	options?: MatchShortcutOptions
): boolean {
	const steps = parseSequence(spec);
	if (steps.length !== 1 || steps[0] === undefined) return false;
	return matchesStep(event, steps[0], options?.strict_platform ?? false);
}

function isMacPlatform(platform?: 'mac' | 'other'): boolean {
	if (platform !== undefined) return platform === 'mac';
	if (typeof navigator === 'undefined') return false;
	return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

/** Converts a shortcut spec into a WAI-ARIA `aria-keyshortcuts` attribute value (e.g. `'Meta+K'` or `'Control+K'`). */
export function aria_keyshortcuts(spec: string, platform?: 'mac' | 'other'): string {
	const mac = isMacPlatform(platform);
	return parseSequence(spec)
		.map((step) => {
			const out: string[] = [];
			if (step.mod) out.push(mac ? 'Meta' : 'Control');
			if (step.ctrl) out.push('Control');
			if (step.meta) out.push('Meta');
			if (step.alt) out.push('Alt');
			if (step.shift) out.push('Shift');
			const k = step.key === 'space' ? 'Space' : step.key.length === 1 ? step.key.toUpperCase() : step.key.charAt(0).toUpperCase() + step.key.slice(1);
			out.push(k);
			return out.join('+');
		})
		.join(' ');
}

/** Formats a shortcut spec for human-readable UI badges (e.g. `'⌘K'` on macOS, `'Ctrl+K'` elsewhere). */
export function format_shortcut(spec: string, platform?: 'mac' | 'other'): string {
	const mac = isMacPlatform(platform);
	const keyMap: Record<string, string> = {
		escape: 'Esc',
		enter: '↵',
		backspace: '⌫',
		space: 'Space',
		arrowup: '↑',
		arrowdown: '↓',
		arrowleft: '←',
		arrowright: '→'
	};
	return parseSequence(spec)
		.map((step) => {
			const parts: string[] = [];
			if (step.mod) parts.push(mac ? '⌘' : 'Ctrl');
			if (step.ctrl) parts.push(mac ? '⌃' : 'Ctrl');
			if (step.alt) parts.push(mac ? '⌥' : 'Alt');
			if (step.shift) parts.push(mac ? '⇧' : 'Shift');
			if (step.meta) parts.push(mac ? '⌘' : 'Meta');
			const displayKey = keyMap[step.key] ?? (step.key.length === 1 ? step.key.toUpperCase() : step.key);
			parts.push(displayKey);
			return mac ? parts.join('') : parts.join('+');
		})
		.join(' ');
}

/**
 * Binds one or more keyboard shortcuts (including multi-key chord sequences like `'g i'`) while
 * mounted, cleaning up automatically when the enclosing component tears down.
 */
export function create_shortcuts(
	bindings: readonly ShortcutBinding[] | (() => readonly ShortcutBinding[]),
	options: { readonly target?: () => EventTarget | null; readonly chord_timeout_ms?: number } = {}
): void {
	const chordTimeout = options.chord_timeout_ms ?? 900;

	$effect(() => {
		const target = options.target ? options.target() : typeof window !== 'undefined' ? window : null;
		if (target === null) return;
		const list = typeof bindings === 'function' ? bindings() : bindings;
		let pendingIndex = 0;
		let pendingCandidates: { readonly binding: ShortcutBinding; readonly steps: readonly ParsedShortcut[] }[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;

		const resetChord = () => {
			pendingIndex = 0;
			pendingCandidates = [];
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};

		const listener = (raw: Event) => {
			if (!(raw instanceof KeyboardEvent) || raw.defaultPrevented || raw.isComposing) return;
			const editable = isEditableTarget(raw.target);

			// Continue active chord sequence if any.
			if (pendingCandidates.length > 0) {
				const nextMatched = pendingCandidates.filter((cand) => {
					const step = cand.steps[pendingIndex];
					return step !== undefined && matchesStep(raw, step);
				});
				if (nextMatched.length > 0) {
					const finished = nextMatched.find((cand) => cand.steps.length === pendingIndex + 1);
					if (finished !== undefined) {
						resetChord();
						if (finished.binding.prevent_default !== false) raw.preventDefault();
						finished.binding.handler(raw);
						return;
					}
					pendingCandidates = nextMatched;
					pendingIndex += 1;
					if (timer !== undefined) clearTimeout(timer);
					timer = setTimeout(resetChord, chordTimeout);
					return;
				}
				resetChord();
			}

			const chordStarts: { readonly binding: ShortcutBinding; readonly steps: readonly ParsedShortcut[] }[] = [];
			for (const binding of list) {
				const on =
					typeof binding.enabled === 'function' ? binding.enabled() : (binding.enabled ?? true);
				if (!on) continue;
				if (!binding.allow_in_input && editable) continue;
				const steps = parseSequence(binding.keys);
				const first = steps[0];
				if (first === undefined || !matchesStep(raw, first)) continue;
				if (steps.length === 1) {
					if (binding.prevent_default !== false) raw.preventDefault();
					binding.handler(raw);
					return;
				}
				chordStarts.push({ binding, steps });
			}

			if (chordStarts.length > 0) {
				pendingCandidates = chordStarts;
				pendingIndex = 1;
				timer = setTimeout(resetChord, chordTimeout);
			}
		};

		target.addEventListener('keydown', listener);
		return () => {
			resetChord();
			target.removeEventListener('keydown', listener);
		};
	});
}
