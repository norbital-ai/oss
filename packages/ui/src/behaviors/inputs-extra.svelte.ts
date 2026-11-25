// Extra headless input behaviors:
// - `create_token_input`: tag/chip/recipient input with delimiter & paste splitting, chip arrow nav, Backspace delete, inline edit & announcements
// - `create_trigger_menu`: inline `@mention` / `/` slash-command trigger menu inside input/textarea with caret anchor & nested levels
// - `create_checkbox_group`: flat checkbox group with tri-state Select All parent
// - `create_file_dropzone`: drag-and-drop + file-input trigger with accept/size/count batch validation
// - `create_password_input`: visibility toggle, CapsLock warning & `data-agent-secret` marking
import type { Attachment } from 'svelte/attachments';
import { announce } from './announce.svelte.js';
import { register_control } from './controls.svelte.js';
import { create_floating, type VirtualAnchor } from './floating.svelte.js';
import { fuzzy_score } from './text-match.js';

/** Options for `create_token_input`. */
export type TokenInputOptions = {
	/** Controlled tokens; omit for internal state. */
	readonly value?: () => readonly string[];
	/** Initial tokens when uncontrolled. */
	readonly default_value?: readonly string[];
	/** Called whenever tokens change. */
	readonly on_change?: (next: readonly string[]) => void;
	/** Delimiter characters that split tokens (default `[',']`). */
	readonly delimiters?: readonly string[];
	/** Allow duplicate tokens (default `false`). */
	readonly allow_duplicates?: boolean;
	/** Maximum token count (optional). */
	readonly max?: number;
	/** Optional validator returning an error message string when rejected, or `null`/`undefined` if valid. */
	readonly validate?: (token: string) => string | null | undefined;
	/** Disabled state. */
	readonly disabled?: () => boolean;
	/** Accessible label. */
	readonly label?: string;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_token_input`. */
export type TokenInput = ReturnType<typeof create_token_input>;

/**
 * Headless chip/tag/recipient token input: splits on delimiters & paste, navigates chips with
 * ArrowLeft/ArrowRight/Home/End, Backspace selects/deletes the last chip, supports inline chip
 * editing and registers with Norbius's control bridge.
 */
export function create_token_input(options: TokenInputOptions = {}) {
	const delimiters = options.delimiters ?? [','];
	const allowDupes = options.allow_duplicates === true;
	let internal = $state<readonly string[]>(options.default_value ?? []);
	let inputText = $state('');
	let activeIndex = $state<number | null>(null);
	let editingIndex = $state<number | null>(null);
	let editingText = $state('');
	let error = $state<string | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	const chipEls = new Map<number, HTMLElement>();

	const tokens = $derived(options.value ? options.value() : internal);
	const disabled = $derived(options.disabled?.() ?? false);

	function emit(next: readonly string[]): void {
		if (!options.value) internal = next;
		options.on_change?.(next);
	}

	function splitRaw(raw: string): string[] {
		if (delimiters.length === 0) return [raw.trim()].filter((s) => s !== '');
		const escaped = delimiters.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
		return raw
			.split(new RegExp(escaped))
			.map((s) => s.trim())
			.filter((s) => s !== '');
	}

	function add_many(raw: string): boolean {
		if (disabled) return false;
		const pieces = splitRaw(raw);
		if (pieces.length === 0) return false;
		const next = [...tokens];
		let added = 0;
		error = null;
		for (const piece of pieces) {
			if (options.max !== undefined && next.length >= options.max) {
				error = `Maximum ${options.max} items`;
				break;
			}
			if (!allowDupes && next.includes(piece)) continue;
			const problem = options.validate?.(piece);
			if (problem != null && problem !== '') {
				error = problem;
				continue;
			}
			next.push(piece);
			added += 1;
		}
		if (added > 0) {
			emit(next);
			announce(`Added ${added === 1 ? (pieces[0] ?? 'item') : `${added} items`}`);
			return true;
		}
		return false;
	}

	function commit_input(): void {
		const raw = inputText;
		if (raw.trim() === '') {
			inputText = '';
			return;
		}
		add_many(raw);
		inputText = '';
	}

	function remove_at(index: number): void {
		if (disabled || index < 0 || index >= tokens.length) return;
		const removed = tokens[index];
		const next = tokens.filter((_, i) => i !== index);
		emit(next);
		if (removed !== undefined) announce(`Removed ${removed}`);
		if (editingIndex === index) editingIndex = null;
		if (activeIndex !== null) {
			if (next.length === 0) {
				activeIndex = null;
				inputEl?.focus();
			} else {
				const target = Math.min(index, next.length - 1);
				activeIndex = target;
				queueMicrotask(() => chipEls.get(target)?.focus());
			}
		}
	}

	function start_edit(index: number): void {
		if (disabled) return;
		const existing = tokens[index];
		if (existing === undefined) return;
		editingIndex = index;
		editingText = existing;
	}

	function commit_edit(): void {
		const idx = editingIndex;
		if (idx === null) return;
		const trimmed = editingText.trim();
		editingIndex = null;
		editingText = '';
		if (trimmed === '') {
			remove_at(idx);
			return;
		}
		const problem = options.validate?.(trimmed);
		if (problem != null && problem !== '') {
			error = problem;
			return;
		}
		if (!allowDupes && tokens.some((t, i) => i !== idx && t === trimmed)) return;
		error = null;
		emit(tokens.map((t, i) => (i === idx ? trimmed : t)));
	}

	function cancel_edit(): void {
		editingIndex = null;
		editingText = '';
	}

	function focusChip(index: number): void {
		if (index < 0 || index >= tokens.length) {
			activeIndex = null;
			inputEl?.focus();
			return;
		}
		activeIndex = index;
		chipEls.get(index)?.focus();
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'token-input',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				element: () => inputEl,
				disabled: () => disabled,
				state: () => ({ values: tokens, count: tokens.length }),
				actions: {
					add: (val) => {
						if (typeof val === 'string') add_many(val);
					},
					remove: (val) => {
						if (typeof val === 'string') {
							const idx = tokens.indexOf(val);
							if (idx >= 0) remove_at(idx);
						} else if (typeof val === 'number') {
							remove_at(val);
						}
					},
					clear: () => emit([])
				}
			})
		);
	}

	const input: Attachment<HTMLInputElement> = (el) => {
		inputEl = el;
		return () => {
			if (inputEl === el) inputEl = null;
		};
	};

	function chip(index: number): Attachment<HTMLElement> {
		return (el) => {
			chipEls.set(index, el);
			return () => {
				if (chipEls.get(index) === el) chipEls.delete(index);
			};
		};
	}

	return {
		get values() {
			return tokens;
		},
		get input_text() {
			return inputText;
		},
		set input_text(v: string) {
			inputText = v;
		},
		get active_index() {
			return activeIndex;
		},
		get editing_index() {
			return editingIndex;
		},
		get editing_text() {
			return editingText;
		},
		set editing_text(v: string) {
			editingText = v;
		},
		get error() {
			return error;
		},
		add: add_many,
		remove_at,
		commit_input,
		start_edit,
		commit_edit,
		cancel_edit,
		input,
		chip,
		input_attrs() {
			return {
				value: inputText,
				disabled: disabled || undefined,
				'aria-label': options.label,
				onfocus: () => {
					activeIndex = null;
				},
				oninput: (event: Event) => {
					if (!(event.currentTarget instanceof HTMLInputElement)) return;
					const val = event.currentTarget.value;
					if (delimiters.some((d) => val.includes(d))) {
						add_many(val);
						inputText = '';
					} else {
						inputText = val;
					}
				},
				onpaste: (event: ClipboardEvent) => {
					const pasted = event.clipboardData?.getData('text') ?? '';
					if (delimiters.some((d) => pasted.includes(d)) || pasted.includes('\n')) {
						event.preventDefault();
						add_many(pasted.replace(/\r?\n/g, delimiters[0] ?? ','));
					}
				},
				onkeydown: (event: KeyboardEvent) => {
					if (event.isComposing) return;
					if (event.key === 'Enter' || delimiters.includes(event.key)) {
						if (inputText.trim() !== '') {
							event.preventDefault();
							commit_input();
						}
					} else if (event.key === 'Backspace' && inputText === '' && tokens.length > 0) {
						event.preventDefault();
						remove_at(tokens.length - 1);
					} else if (event.key === 'ArrowLeft' && inputText === '' && tokens.length > 0) {
						event.preventDefault();
						focusChip(tokens.length - 1);
					}
				},
				onblur: () => {
					commit_input();
				}
			};
		},
		chip_attrs(index: number) {
			return {
				tabindex: activeIndex === index ? 0 : -1,
				'data-active': activeIndex === index ? '' : undefined,
				'data-editing': editingIndex === index ? '' : undefined,
				onfocus: () => {
					activeIndex = index;
				},
				ondblclick: () => start_edit(index),
				onkeydown: (event: KeyboardEvent) => {
					if (editingIndex === index) return;
					if (event.key === 'ArrowLeft') {
						event.preventDefault();
						focusChip(Math.max(0, index - 1));
					} else if (event.key === 'ArrowRight') {
						event.preventDefault();
						focusChip(index + 1);
					} else if (event.key === 'Home') {
						event.preventDefault();
						focusChip(0);
					} else if (event.key === 'End') {
						event.preventDefault();
						focusChip(tokens.length);
					} else if (event.key === 'Backspace' || event.key === 'Delete') {
						event.preventDefault();
						remove_at(index);
					} else if (event.key === 'Enter' || event.key === 'F2') {
						event.preventDefault();
						start_edit(index);
					} else if (event.key === 'Escape') {
						event.preventDefault();
						activeIndex = null;
						inputEl?.focus();
					}
				}
			};
		}
	};
}

/** One item offered by `create_trigger_menu`. */
export type TriggerMenuItem = {
	readonly id: string;
	readonly label: string;
	readonly keywords?: string;
	readonly insert?: string;
	readonly disabled?: boolean;
	readonly children?: readonly TriggerMenuItem[];
};

/** Active trigger match inside a text field. */
export type TriggerMatch = {
	readonly trigger: string;
	readonly query: string;
	readonly start: number;
	readonly end: number;
};

/** Options for `create_trigger_menu`. */
export type TriggerMenuOptions<T extends TriggerMenuItem = TriggerMenuItem> = {
	/** Trigger prefixes that open the menu (e.g. `['@', '/']`). */
	readonly triggers: readonly string[];
	/** Returns items for the active trigger & nested level stack. */
	readonly items: (trigger: string, query: string, path: readonly T[]) => readonly T[];
	/** Called when a leaf item is picked (receives item and replacement range). */
	readonly on_select: (item: T, match: TriggerMatch, insertText: string) => void;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_trigger_menu`. */
export type TriggerMenu<T extends TriggerMenuItem = TriggerMenuItem> = ReturnType<typeof create_trigger_menu<T>>;

function detectTrigger(text: string, caret: number, triggers: readonly string[]): TriggerMatch | null {
	const before = text.slice(0, caret);
	for (let i = before.length - 1; i >= 0; i--) {
		const ch = before.charAt(i);
		if (/\s/.test(ch)) return null;
		for (const trigger of triggers) {
			if (!before.slice(i).startsWith(trigger)) continue;
			const prev = i > 0 ? before.charAt(i - 1) : '';
			if (i === 0 || /[\s([{"']/.test(prev)) {
				return {
					trigger,
					query: before.slice(i + trigger.length),
					start: i,
					end: caret
				};
			}
		}
	}
	return null;
}

/**
 * Inline `@mention` / `/` slash-command trigger menu for `<input>` and `<textarea>`:
 * tracks caret trigger matches, fuzzy-filters items, supports nested sub-menus (`children`),
 * keyboard navigation (`ArrowUp`/`ArrowDown`/`Enter`/`Tab`/`Escape`), floating anchor positioning
 * and Norbius control registration.
 */
export function create_trigger_menu<T extends TriggerMenuItem = TriggerMenuItem>(options: TriggerMenuOptions<T>) {
	let match = $state<TriggerMatch | null>(null);
	let path = $state.raw<readonly T[]>([]);
	let activeIndex = $state(0);
	let fieldEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
	let anchorRect = $state<VirtualAnchor | null>(null);

	const rawItems = $derived(match === null ? [] : options.items(match.trigger, match.query, path));
	const filtered = $derived.by((): readonly T[] => {
		if (match === null) return [];
		const q = match.query.trim();
		if (q === '') return rawItems;
		return rawItems
			.map((item) => ({
				item,
				score: fuzzy_score(q, `${item.label} ${item.keywords ?? ''}`)
			}))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((entry) => entry.item);
	});

	const open = $derived(match !== null && filtered.length > 0);
	const clampedIndex = $derived(
		filtered.length === 0 ? -1 : Math.max(0, Math.min(activeIndex, filtered.length - 1))
	);

	function close(): void {
		match = null;
		path = [];
		activeIndex = 0;
	}

	function syncFromField(el: HTMLInputElement | HTMLTextAreaElement): void {
		const caret = el.selectionStart ?? el.value.length;
		const found = detectTrigger(el.value, caret, options.triggers);
		if (found === null) {
			if (match !== null) close();
			return;
		}
		if (match === null || match.trigger !== found.trigger || match.start !== found.start) {
			path = [];
			activeIndex = 0;
		}
		match = found;
		const box = el.getBoundingClientRect();
		anchorRect = {
			getBoundingClientRect: () => new DOMRect(box.left, box.bottom, 1, 1)
		};
	}

	function select(item: T): void {
		if (item.disabled || match === null) return;
		if (item.children !== undefined && item.children.length > 0) {
			path = [...path, item];
			activeIndex = 0;
			return;
		}
		const currentMatch = match;
		const insertText = item.insert ?? `${currentMatch.trigger}${item.label} `;
		options.on_select(item, currentMatch, insertText);
		close();
	}

	function step(delta: 1 | -1): void {
		const len = filtered.length;
		if (len === 0) return;
		for (let i = 1; i <= len; i++) {
			const idx = (clampedIndex + delta * i + len) % len;
			if (!filtered[idx]?.disabled) {
				activeIndex = idx;
				return;
			}
		}
	}

	const floating = create_floating({
		open: () => open,
		anchor: () => anchorRect,
		side: 'bottom',
		align: 'start',
		on_dismiss: close
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'trigger-menu',
				...(meta.label !== undefined ? { label: meta.label } : {}),
				element: () => fieldEl,
				state: () => ({ open, trigger: match?.trigger ?? null, query: match?.query ?? '', count: filtered.length }),
				items: () => filtered.filter((i) => !i.disabled).map((i) => ({ value: i.id, label: i.label })),
				actions: {
					select: (id) => {
						const target = filtered.find((i) => i.id === id);
						if (target !== undefined) select(target);
					},
					close
				}
			})
		);
	}

	const field: Attachment<HTMLInputElement | HTMLTextAreaElement> = (el) => {
		fieldEl = el;
		return () => {
			if (fieldEl === el) fieldEl = null;
		};
	};

	return {
		get open() {
			return open;
		},
		get match() {
			return match;
		},
		get items() {
			return filtered;
		},
		get path() {
			return path;
		},
		get active_index() {
			return clampedIndex;
		},
		get floating() {
			return floating;
		},
		close,
		select,
		pop_level() {
			if (path.length > 0) {
				path = path.slice(0, -1);
				activeIndex = 0;
			}
		},
		field,
		content: floating.content,
		input_attrs() {
			const active = clampedIndex >= 0 ? filtered[clampedIndex] : undefined;
			return {
				'aria-expanded': open,
				'aria-haspopup': 'listbox' as const,
				'aria-activedescendant': open && active !== undefined ? `trigger-opt-${active.id}` : undefined,
				oninput: (event: Event) => {
					if (event.currentTarget instanceof HTMLInputElement || event.currentTarget instanceof HTMLTextAreaElement) {
						syncFromField(event.currentTarget);
					}
				},
				onkeyup: (event: KeyboardEvent) => {
					if (
						(event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
						(event.currentTarget instanceof HTMLInputElement || event.currentTarget instanceof HTMLTextAreaElement)
					) {
						syncFromField(event.currentTarget);
					}
				},
				onkeydown: (event: KeyboardEvent) => {
					if (!open) return;
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						step(1);
					} else if (event.key === 'ArrowUp') {
						event.preventDefault();
						step(-1);
					} else if (event.key === 'Enter' || event.key === 'Tab') {
						const item = clampedIndex >= 0 ? filtered[clampedIndex] : undefined;
						if (item !== undefined && !item.disabled) {
							event.preventDefault();
							select(item);
						}
					} else if (event.key === 'Backspace' && path.length > 0 && match?.query === '') {
						event.preventDefault();
						path = path.slice(0, -1);
						activeIndex = 0;
					} else if (event.key === 'Escape') {
						event.preventDefault();
						close();
					}
				}
			};
		},
		option_attrs(item: T, index: number) {
			const active = index === clampedIndex;
			return {
				id: `trigger-opt-${item.id}`,
				role: 'option' as const,
				'aria-selected': active,
				'aria-disabled': item.disabled ? (true as const) : undefined,
				'data-highlighted': active ? '' : undefined,
				onpointerenter: () => {
					if (!item.disabled) activeIndex = index;
				},
				onmousedown: (event: MouseEvent) => {
					event.preventDefault();
				},
				onclick: () => select(item)
			};
		}
	};
}

/** Options for `create_checkbox_group`. */
export type CheckboxGroupOptions = {
	/** All selectable item keys. */
	readonly items: () => readonly string[];
	/** Controlled checked keys; omit for internal state. */
	readonly value?: () => readonly string[];
	/** Initial checked keys when uncontrolled. */
	readonly default_value?: readonly string[];
	/** Called when checked keys change. */
	readonly on_change?: (next: readonly string[]) => void;
	/** Per-item disabled predicate. */
	readonly disabled?: (key: string) => boolean;
	/** Accessible label for the group. */
	readonly label?: string;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_checkbox_group`. */
export type CheckboxGroup = ReturnType<typeof create_checkbox_group>;

/**
 * Headless flat checkbox group with tri-state Select All parent (`true | false | 'indeterminate'`)
 * and Norbius control registration.
 */
export function create_checkbox_group(options: CheckboxGroupOptions) {
	let internal = $state<readonly string[]>(options.default_value ?? []);
	const selected = $derived(options.value ? options.value() : internal);
	const selectedSet = $derived(new Set(selected));
	const enabledItems = $derived(options.items().filter((k) => !options.disabled?.(k)));

	const all_state = $derived.by((): boolean | 'indeterminate' => {
		if (enabledItems.length === 0) return false;
		const checkedCount = enabledItems.filter((k) => selectedSet.has(k)).length;
		if (checkedCount === 0) return false;
		if (checkedCount === enabledItems.length) return true;
		return 'indeterminate';
	});

	function commit(next: readonly string[]): void {
		if (!options.value) internal = next;
		options.on_change?.(next);
	}

	function toggle(key: string): void {
		if (options.disabled?.(key)) return;
		commit(selectedSet.has(key) ? selected.filter((k) => k !== key) : [...selected, key]);
	}

	function toggle_all(): void {
		if (all_state === true) {
			const enabledSet = new Set(enabledItems);
			commit(selected.filter((k) => !enabledSet.has(k)));
		} else {
			const merged = new Set(selected);
			for (const k of enabledItems) merged.add(k);
			commit([...merged]);
		}
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'checkbox-group',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ checked: selected, all: all_state }),
				items: () => enabledItems.map((k) => ({ value: k, label: k })),
				actions: {
					toggle: (k) => {
						if (typeof k === 'string') toggle(k);
					},
					toggle_all
				}
			})
		);
	}

	return {
		get checked() {
			return selected;
		},
		get all_state() {
			return all_state;
		},
		is_checked(key: string): boolean {
			return selectedSet.has(key);
		},
		toggle,
		toggle_all,
		group_attrs() {
			return {
				role: 'group' as const,
				'aria-label': options.label
			};
		},
		all_attrs() {
			return {
				type: 'checkbox' as const,
				checked: all_state === true,
				'aria-checked': all_state === 'indeterminate' ? ('mixed' as const) : all_state,
				onchange: () => toggle_all()
			};
		},
		item_attrs(key: string) {
			const off = options.disabled?.(key) === true;
			return {
				type: 'checkbox' as const,
				checked: selectedSet.has(key),
				disabled: off || undefined,
				onchange: () => toggle(key)
			};
		}
	};
}

/** One rejected file from `create_file_dropzone` validation. */
export type RejectedFile = {
	readonly file: File;
	readonly reason: 'type' | 'size' | 'count';
};

/** Options for `create_file_dropzone`. */
export type FileDropzoneOptions = {
	/** Accepted MIME types or extensions (e.g. `['image/*', '.pdf']`). */
	readonly accept?: readonly string[];
	/** Maximum file size in bytes. */
	readonly max_bytes?: number;
	/** Maximum number of files accepted in one drop/selection (default unlimited). */
	readonly max_files?: number;
	/** Disabled state. */
	readonly disabled?: () => boolean;
	/** Called with validated accepted and rejected files. */
	readonly on_files: (result: { readonly accepted: readonly File[]; readonly rejected: readonly RejectedFile[] }) => void;
};

/** Return value of `create_file_dropzone`. */
export type FileDropzone = ReturnType<typeof create_file_dropzone>;

function matchesAccept(file: File, accept: readonly string[]): boolean {
	if (accept.length === 0 || accept.includes('*/*')) return true;
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	for (const raw of accept) {
		const rule = raw.trim().toLowerCase();
		if (rule === '' || rule === '*/*') return true;
		if (rule.startsWith('.')) {
			if (name.endsWith(rule)) return true;
		} else if (rule.endsWith('/*')) {
			if (type.startsWith(rule.slice(0, -1))) return true;
		} else if (type === rule) {
			return true;
		}
	}
	return false;
}

/**
 * Headless file dropzone & batch validator: depth-counted drag-over state (zero child flicker),
 * accept MIME/extension, max size and max count filtering, and file-input bridge.
 */
export function create_file_dropzone(options: FileDropzoneOptions) {
	let depth = 0;
	let dragging = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	const disabled = $derived(options.disabled?.() ?? false);

	function process(list: FileList | readonly File[]): void {
		if (disabled) return;
		const files = Array.from(list);
		const accept = options.accept ?? [];
		const accepted: File[] = [];
		const rejected: RejectedFile[] = [];

		for (const file of files) {
			if (!matchesAccept(file, accept)) {
				rejected.push({ file, reason: 'type' });
				continue;
			}
			if (options.max_bytes !== undefined && file.size > options.max_bytes) {
				rejected.push({ file, reason: 'size' });
				continue;
			}
			if (options.max_files !== undefined && accepted.length >= options.max_files) {
				rejected.push({ file, reason: 'count' });
				continue;
			}
			accepted.push(file);
		}
		if (accepted.length > 0 || rejected.length > 0) {
			options.on_files({ accepted, rejected });
		}
	}

	const zone: Attachment<HTMLElement> = (el) => {
		const onEnter = (event: DragEvent) => {
			if (disabled) return;
			event.preventDefault();
			depth += 1;
			dragging = true;
		};
		const onOver = (event: DragEvent) => {
			if (disabled) return;
			event.preventDefault();
			dragging = true;
			if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'copy';
		};
		const onLeave = () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) dragging = false;
		};
		const onDrop = (event: DragEvent) => {
			event.preventDefault();
			depth = 0;
			dragging = false;
			if (!disabled && event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
				process(event.dataTransfer.files);
			}
		};
		el.addEventListener('dragenter', onEnter);
		el.addEventListener('dragover', onOver);
		el.addEventListener('dragleave', onLeave);
		el.addEventListener('drop', onDrop);
		return () => {
			el.removeEventListener('dragenter', onEnter);
			el.removeEventListener('dragover', onOver);
			el.removeEventListener('dragleave', onLeave);
			el.removeEventListener('drop', onDrop);
		};
	};

	const input: Attachment<HTMLInputElement> = (el) => {
		inputEl = el;
		return () => {
			if (inputEl === el) inputEl = null;
		};
	};

	return {
		get dragging() {
			return dragging;
		},
		get disabled() {
			return disabled;
		},
		open() {
			if (!disabled) inputEl?.click();
		},
		process,
		zone,
		input,
		input_attrs() {
			return {
				type: 'file' as const,
				accept: options.accept?.join(','),
				multiple: options.max_files === undefined || options.max_files > 1 ? true : undefined,
				disabled: disabled || undefined,
				onchange: (event: Event) => {
					if (!(event.currentTarget instanceof HTMLInputElement)) return;
					const files = event.currentTarget.files;
					if (files !== null && files.length > 0) process(files);
					event.currentTarget.value = '';
				}
			};
		}
	};
}

/** Options for `create_password_input`. */
export type PasswordInputOptions = {
	/** Initial visibility (default `false`). */
	readonly default_visible?: boolean;
	/** Accessible label for the password input. */
	readonly label?: string;
	/** Optional semantic control registration (always marked `secret: true`). */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_password_input`. */
export type PasswordInput = ReturnType<typeof create_password_input>;

/**
 * Headless password input behavior: visibility toggle, CapsLock warning detection and automatic
 * `data-agent-secret` protection so secret values never leak into agent snapshots.
 */
export function create_password_input(options: PasswordInputOptions = {}) {
	let visible = $state(options.default_visible === true);
	let capsLock = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	function toggle(): void {
		visible = !visible;
	}

	function checkCaps(event: KeyboardEvent): void {
		if (typeof event.getModifierState === 'function') {
			capsLock = event.getModifierState('CapsLock');
		}
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'password',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				element: () => inputEl,
				secret: true,
				state: () => ({ visible, caps_lock: capsLock }),
				actions: { toggle }
			})
		);
	}

	const input: Attachment<HTMLInputElement> = (el) => {
		inputEl = el;
		return () => {
			if (inputEl === el) inputEl = null;
		};
	};

	return {
		get visible() {
			return visible;
		},
		get caps_lock() {
			return capsLock;
		},
		toggle,
		set_visible(next: boolean) {
			visible = next;
		},
		input,
		input_attrs() {
			return {
				type: visible ? ('text' as const) : ('password' as const),
				'data-agent-secret': '',
				'aria-label': options.label,
				onkeydown: checkCaps,
				onkeyup: checkCaps
			};
		},
		toggle_attrs() {
			return {
				type: 'button' as const,
				'aria-pressed': visible,
				'aria-label': visible ? 'Hide password' : 'Show password',
				onclick: toggle
			};
		}
	};
}
