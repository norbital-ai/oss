// Productivity & interaction micro-behaviors:
// - `create_input_history`: ArrowUp/Down recall through previous messages/commands at line edges
// - `create_undo_stack`: grouped/coalesced undo/redo history for any state
// - `bind_hold` & `bind_repeat`: long-press detection & hold-to-repeat steppers
// - `input_hints`: consistent mobile keyboard, enterKeyHint & autofill attribute presets
// - `nearest_in_direction` & `spatial_move`: 2D geometric directional focus navigation
import type { Attachment } from 'svelte/attachments';

/** Options for `create_input_history`. */
export type InputHistoryOptions<T = string> = {
	/** Past entries, oldest first. */
	readonly entries: () => readonly T[];
	/** Reads the current composer value. */
	readonly read: () => T;
	/** Writes a recalled value into the composer; return `false` to cancel navigation. */
	readonly write: (value: T, event: KeyboardEvent) => boolean | void;
	/** Custom edge detector; defaults to first/last line of `<textarea>` or anywhere in `<input>`. */
	readonly at_edge?: (direction: 'up' | 'down', event: KeyboardEvent) => boolean;
};

/** Return value of `create_input_history`. */
export type InputHistory<T = string> = ReturnType<typeof create_input_history<T>>;

function defaultAtEdge(direction: 'up' | 'down', event: KeyboardEvent): boolean {
	const target = event.target;
	if (target instanceof HTMLInputElement) return true;
	if (!(target instanceof HTMLTextAreaElement)) return true;
	const start = target.selectionStart ?? 0;
	const end = target.selectionEnd ?? 0;
	if (start !== end) return false;
	const text = target.value;
	if (direction === 'up') return !text.slice(0, start).includes('\n');
	return !text.slice(end).includes('\n');
}

/**
 * Terminal / chat-composer ArrowUp & ArrowDown history recall that preserves the user's unsent draft
 * and only triggers when the caret sits on the first (ArrowUp) or last (ArrowDown) line.
 */
export function create_input_history<T = string>(options: InputHistoryOptions<T>) {
	let index = $state<number | null>(null);
	let savedDraft: T | undefined;

	function reset(): void {
		index = null;
		savedDraft = undefined;
	}

	function onkeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

		const direction = event.key === 'ArrowUp' ? 'up' : 'down';
		const atEdge = options.at_edge ?? defaultAtEdge;
		if (!atEdge(direction, event)) return;

		const list = options.entries();
		if (list.length === 0) return;

		if (direction === 'up') {
			const nextIdx = index === null ? list.length - 1 : Math.max(0, index - 1);
			if (index === nextIdx) return;
			const target = list[nextIdx];
			if (target === undefined) return;
			if (index === null) savedDraft = options.read();
			if (options.write(target, event) === false) return;
			index = nextIdx;
			event.preventDefault();
			return;
		}

		if (index === null) return;
		if (index >= list.length - 1) {
			const draft = savedDraft;
			if (draft !== undefined && options.write(draft, event) === false) return;
			reset();
			event.preventDefault();
			return;
		}
		const nextIdx = index + 1;
		const target = list[nextIdx];
		if (target === undefined) return;
		if (options.write(target, event) === false) return;
		index = nextIdx;
		event.preventDefault();
	}

	return {
		get index() {
			return index;
		},
		get browsing() {
			return index !== null;
		},
		onkeydown,
		reset
	};
}

/** Options for `create_undo_stack`. */
export type UndoStackOptions = {
	/** Maximum history depth (default `100`). */
	readonly limit?: number;
	/** Coalescing window in ms for edits sharing the same `group` (default `500`). */
	readonly group_delay_ms?: number;
};

/** Return value of `create_undo_stack`. */
export type UndoStack<T> = ReturnType<typeof create_undo_stack<T>>;

/**
 * Grouped undo/redo stack for any immutable state value. Consecutive edits with the same `group`
 * arriving within `group_delay_ms` coalesce into one undo entry.
 */
export function create_undo_stack<T>(initial: T, options: UndoStackOptions = {}) {
	const limit = Math.max(1, options.limit ?? 100);
	const groupDelay = options.group_delay_ms ?? 500;
	let entries = $state.raw<T[]>([initial]);
	let cursor = $state(0);
	let current = $state.raw<T>(initial);
	let openGroup: { readonly name: string; readonly time: number } | null = null;

	const can_undo = $derived(cursor > 0);
	const can_redo = $derived(cursor < entries.length - 1);

	function record(next: T, opts: { readonly group?: string; readonly time?: number } = {}): void {
		const now = opts.time ?? Date.now();
		const coalesce =
			opts.group !== undefined &&
			openGroup !== null &&
			openGroup.name === opts.group &&
			now - openGroup.time <= groupDelay &&
			cursor > 0;

		let trimmed = entries.slice(0, cursor + 1);
		if (coalesce) {
			trimmed = [...trimmed.slice(0, -1), next];
		} else {
			trimmed = [...trimmed, next];
			if (trimmed.length > limit) trimmed = trimmed.slice(trimmed.length - limit);
		}
		entries = trimmed;
		cursor = trimmed.length - 1;
		current = next;
		openGroup = opts.group !== undefined ? { name: opts.group, time: now } : null;
	}

	function undo(): T {
		openGroup = null;
		if (cursor > 0) {
			cursor -= 1;
			const next = entries[cursor];
			if (next !== undefined) current = next;
		}
		return current;
	}

	function redo(): T {
		openGroup = null;
		if (cursor < entries.length - 1) {
			cursor += 1;
			const next = entries[cursor];
			if (next !== undefined) current = next;
		}
		return current;
	}

	function reset(value: T): void {
		openGroup = null;
		entries = [value];
		cursor = 0;
		current = value;
	}

	return {
		get current() {
			return current;
		},
		get can_undo() {
			return can_undo;
		},
		get can_redo() {
			return can_redo;
		},
		get length() {
			return entries.length;
		},
		record,
		undo,
		redo,
		reset
	};
}

/** Input modality that started a hold gesture. */
export type HoldInput = 'mouse' | 'touch' | 'pen' | 'keyboard';

/** Options for `bind_hold`. */
export type BindHoldOptions = {
	/** Hold duration in ms before `on_hold` fires (default `500`). */
	readonly delay?: number;
	/** Max pointer drift in px before canceling (default `8`). */
	readonly tolerance?: number;
	/** Keys that start a keyboard hold (default `[' ', 'Enter']`). */
	readonly keys?: readonly string[];
	/** Called when press starts. */
	readonly on_start?: (details: { readonly event: PointerEvent | KeyboardEvent; readonly input: HoldInput }) => void;
	/** Called once the press crosses `delay`. */
	readonly on_hold: (details: { readonly event: PointerEvent | KeyboardEvent; readonly input: HoldInput }) => void;
	/** Called when the press lifts or cancels. */
	readonly on_end?: (details: { readonly event: Event; readonly input: HoldInput; readonly held: boolean; readonly canceled: boolean }) => void;
	/** Disable reactively. */
	readonly disabled?: () => boolean;
};

/**
 * Long-press attachment (`{@attach bind_hold(...)}`) with movement tolerance, Escape/blur cancel
 * and automatic click suppression after a completed hold.
 */
export function bind_hold(options: BindHoldOptions): Attachment<HTMLElement> {
	return (el) => {
		const delay = options.delay ?? 500;
		const tolerance = options.tolerance ?? 8;
		const keys = options.keys ?? [' ', 'Enter'];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let active = false;
		let held = false;
		let suppressClick = false;
		let input: HoldInput = 'mouse';
		let startX = 0;
		let startY = 0;

		const clearTimer = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};

		const finish = (event: Event, canceled: boolean) => {
			if (!active) return;
			clearTimer();
			active = false;
			if (held || canceled) suppressClick = true;
			const wasHeld = held;
			held = false;
			options.on_end?.({ event, input, held: wasHeld, canceled });
		};

		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0 || options.disabled?.()) return;
			suppressClick = false;
			active = true;
			held = false;
			input = event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse';
			startX = event.clientX;
			startY = event.clientY;
			options.on_start?.({ event, input });
			clearTimer();
			timer = setTimeout(() => {
				timer = undefined;
				if (!active) return;
				held = true;
				options.on_hold({ event, input });
			}, delay);
		};

		const onPointerMove = (event: PointerEvent) => {
			if (!active || input === 'keyboard') return;
			if (Math.hypot(event.clientX - startX, event.clientY - startY) > tolerance) {
				finish(event, true);
			}
		};

		const onPointerUp = (event: PointerEvent) => finish(event, false);
		const onPointerCancel = (event: PointerEvent) => finish(event, true);

		const onKeydown = (event: KeyboardEvent) => {
			if (event.repeat || options.disabled?.()) return;
			if (event.key === 'Escape' && active) {
				finish(event, true);
				return;
			}
			if (!keys.includes(event.key)) return;
			active = true;
			held = false;
			input = 'keyboard';
			options.on_start?.({ event, input });
			clearTimer();
			timer = setTimeout(() => {
				timer = undefined;
				if (!active) return;
				held = true;
				options.on_hold({ event, input });
			}, delay);
		};

		const onKeyup = (event: KeyboardEvent) => {
			if (active && input === 'keyboard' && keys.includes(event.key)) finish(event, false);
		};

		const onBlur = (event: FocusEvent) => finish(event, true);
		const onClick = (event: MouseEvent) => {
			if (!suppressClick) return;
			suppressClick = false;
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		el.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerCancel);
		el.addEventListener('keydown', onKeydown);
		el.addEventListener('keyup', onKeyup);
		el.addEventListener('blur', onBlur);
		el.addEventListener('click', onClick, true);

		return () => {
			clearTimer();
			el.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerCancel);
			el.removeEventListener('keydown', onKeydown);
			el.removeEventListener('keyup', onKeyup);
			el.removeEventListener('blur', onBlur);
			el.removeEventListener('click', onClick, true);
		};
	};
}

/** Options for `bind_repeat`. */
export type BindRepeatOptions = {
	/** Called immediately on press and repeatedly while held. */
	readonly on_step: (count: number) => void;
	/** Called when the repeating press stops. */
	readonly on_end?: (count: number) => void;
	/** Delay before repeating begins in ms (default `400`). */
	readonly delay?: number;
	/** Interval between repeated steps in ms (default `60`). */
	readonly interval?: number;
	/** Disable reactively. */
	readonly disabled?: () => boolean;
};

/**
 * Press-and-hold repeating attachment (`{@attach bind_repeat(...)}`) for number-input steppers
 * and scrub buttons. Fires once immediately, waits `delay`, then repeats every `interval`.
 */
export function bind_repeat(options: BindRepeatOptions): Attachment<HTMLElement> {
	return (el) => {
		const delay = options.delay ?? 400;
		const interval = options.interval ?? 60;
		let delayTimer: ReturnType<typeof setTimeout> | undefined;
		let repeatTimer: ReturnType<typeof setInterval> | undefined;
		let count = 0;
		let active = false;

		const stop = () => {
			if (delayTimer !== undefined) {
				clearTimeout(delayTimer);
				delayTimer = undefined;
			}
			if (repeatTimer !== undefined) {
				clearInterval(repeatTimer);
				repeatTimer = undefined;
			}
			if (active) {
				active = false;
				options.on_end?.(count);
				count = 0;
			}
		};

		const step = () => {
			if (options.disabled?.()) {
				stop();
				return;
			}
			count += 1;
			options.on_step(count);
		};

		const start = () => {
			if (options.disabled?.() || active) return;
			active = true;
			count = 0;
			step();
			delayTimer = setTimeout(() => {
				delayTimer = undefined;
				if (!active) return;
				repeatTimer = setInterval(step, interval);
			}, delay);
		};

		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			event.preventDefault();
			start();
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (event.repeat) return;
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				start();
			}
		};

		el.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointerup', stop);
		window.addEventListener('pointercancel', stop);
		el.addEventListener('pointerleave', stop);
		el.addEventListener('keydown', onKeydown);
		el.addEventListener('keyup', stop);
		el.addEventListener('blur', stop);

		return () => {
			stop();
			el.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointerup', stop);
			window.removeEventListener('pointercancel', stop);
			el.removeEventListener('pointerleave', stop);
			el.removeEventListener('keydown', onKeydown);
			el.removeEventListener('keyup', stop);
			el.removeEventListener('blur', stop);
		};
	};
}

/** Label shown on mobile virtual keyboard Return keys (`enterkeyhint`). */
export type EnterKeyHint = 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';

/** Supported semantic input hint presets. */
export type InputHintKind =
	| 'search'
	| 'email'
	| 'tel'
	| 'url'
	| 'one-time-code'
	| 'numeric'
	| 'decimal'
	| 'name'
	| 'username'
	| 'current-password'
	| 'new-password'
	| 'postal-code'
	| 'message';

/** HTML input hint attributes returned by `input_hints`. */
export type InputHints = {
	readonly inputmode?: 'search' | 'email' | 'tel' | 'url' | 'numeric' | 'decimal';
	readonly enterkeyhint?: EnterKeyHint;
	readonly autocomplete?: string;
	readonly autocapitalize?: 'none' | 'sentences' | 'words' | 'characters';
	readonly autocorrect?: 'on' | 'off';
	readonly spellcheck?: boolean;
};

/** Returns consistent mobile keyboard, autocomplete and spellcheck attributes for a semantic field kind. */
export function input_hints(
	kind: InputHintKind,
	overrides: { readonly enterkeyhint?: EnterKeyHint } = {}
): InputHints {
	const presets: Record<InputHintKind, InputHints> = {
		search: { inputmode: 'search', enterkeyhint: 'search', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		email: { inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		tel: { inputmode: 'tel', autocomplete: 'tel' },
		url: { inputmode: 'url', autocomplete: 'url', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		'one-time-code': { inputmode: 'numeric', autocomplete: 'one-time-code', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		numeric: { inputmode: 'numeric', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		decimal: { inputmode: 'decimal', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		name: { autocomplete: 'name', autocapitalize: 'words', spellcheck: false },
		username: { autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		'current-password': { autocomplete: 'current-password', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		'new-password': { autocomplete: 'new-password', autocapitalize: 'none', autocorrect: 'off', spellcheck: false },
		'postal-code': { autocomplete: 'postal-code', autocapitalize: 'characters', autocorrect: 'off', spellcheck: false },
		message: { enterkeyhint: 'send', autocapitalize: 'sentences', autocorrect: 'on', spellcheck: true }
	};
	const base = presets[kind];
	return overrides.enterkeyhint !== undefined ? { ...base, enterkeyhint: overrides.enterkeyhint } : base;
}

/** Bounding box used by geometric spatial navigation. */
export type SpatialRect = {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
};

/** Cardinal direction for `nearest_in_direction` / `spatial_move`. */
export type SpatialDirection = 'up' | 'down' | 'left' | 'right';

/** Returns the index of the nearest candidate rectangle strictly in `direction` from `from`, or `-1`. */
export function nearest_in_direction(
	from: SpatialRect,
	candidates: readonly SpatialRect[],
	direction: SpatialDirection
): number {
	const fx = from.left + from.width / 2;
	const fy = from.top + from.height / 2;
	let bestIndex = -1;
	let bestScore = Number.POSITIVE_INFINITY;

	for (let i = 0; i < candidates.length; i++) {
		const rect = candidates[i];
		if (rect === undefined) continue;
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const dx = cx - fx;
		const dy = cy - fy;

		const primary =
			direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
		if (primary <= 1) continue;
		const secondary = direction === 'right' || direction === 'left' ? Math.abs(dy) : Math.abs(dx);
		// Weight orthogonal offset heavily so aligned rows/columns win over closer diagonal items.
		const score = primary + secondary * 2.5;
		if (score < bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}
	return bestIndex;
}

/** Finds the nearest focusable element in `direction` from `current` among `elements`. */
export function spatial_move(
	current: HTMLElement,
	elements: readonly HTMLElement[],
	direction: SpatialDirection
): HTMLElement | null {
	const others = elements.filter((el) => el !== current);
	if (others.length === 0) return null;
	const idx = nearest_in_direction(
		current.getBoundingClientRect(),
		others.map((el) => el.getBoundingClientRect()),
		direction
	);
	return idx >= 0 ? (others[idx] ?? null) : null;
}
