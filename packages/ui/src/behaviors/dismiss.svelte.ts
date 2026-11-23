// LIFO dismissible layer stack for popovers, menus, dialogs, drawers and sheets.
// Handles Escape (topmost layer only, outside IME composition) and optional outside pointer dismissal.
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

/** Why a dismissible layer was closed (`'escape'` or `'outside'`). */
export type DismissReason = 'escape' | 'outside';

/** Options for `create_dismiss`. */
export type DismissOptions = {
	/** Whether this layer is currently active/open. */
	open: () => boolean;
	/** Called when the topmost layer should close. */
	on_dismiss: (reason: DismissReason, event: KeyboardEvent | PointerEvent) => void;
	/** Close on Escape key (default `true`). */
	escape?: boolean | (() => boolean);
	/** Close on pointerdown outside the attached surface (default `true`). */
	outside?: boolean | (() => boolean);
	/** Extra elements treated as inside (e.g. an anchor trigger button). */
	ignore?: () => readonly (Element | null | undefined)[];
};

/** Return value of `create_dismiss`. */
export type DismissLayer = ReturnType<typeof create_dismiss>;

type LayerEntry = { readonly id: symbol };

let stack = $state<readonly LayerEntry[]>([]);

function pushLayer(entry: LayerEntry): void {
	stack = [...stack.filter((item) => item.id !== entry.id), entry];
}

function popLayer(entry: LayerEntry): void {
	if (!stack.some((item) => item.id === entry.id)) return;
	stack = stack.filter((item) => item.id !== entry.id);
}

/**
 * Headless LIFO overlay dismissal behavior. Attach `surface` to the floating/dialog element so
 * nested overlays dismiss one layer at a time on Escape or outside click.
 */
export function create_dismiss(options: DismissOptions) {
	const entry: LayerEntry = { id: Symbol('dismiss-layer') };
	let surfaceEl: HTMLElement | null = null;

	const depth = $derived(stack.findIndex((item) => item.id === entry.id));
	const topmost = $derived(stack.length > 0 && stack.at(-1)?.id === entry.id);

	$effect(() => {
		if (!options.open()) {
			untrack(() => popLayer(entry));
			return;
		}
		untrack(() => pushLayer(entry));

		const onKeydown = (event: KeyboardEvent) => {
			const allowEscape =
				typeof options.escape === 'function' ? options.escape() : options.escape !== false;
			if (!allowEscape) return;
			if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
			if (stack.at(-1)?.id !== entry.id) return;
			options.on_dismiss('escape', event);
			if (!event.defaultPrevented) event.preventDefault();
		};

		const onPointerdown = (event: PointerEvent) => {
			const allowOutside =
				typeof options.outside === 'function' ? options.outside() : options.outside !== false;
			if (!allowOutside) return;
			if (stack.at(-1)?.id !== entry.id) return;
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (surfaceEl !== null && surfaceEl.contains(target)) return;
			const ignored = options.ignore?.() ?? [];
			if (ignored.some((el) => el !== null && el !== undefined && el.contains(target))) return;
			options.on_dismiss('outside', event);
		};

		document.addEventListener('keydown', onKeydown);
		document.addEventListener('pointerdown', onPointerdown, true);
		return () => {
			document.removeEventListener('keydown', onKeydown);
			document.removeEventListener('pointerdown', onPointerdown, true);
			untrack(() => popLayer(entry));
		};
	});

	const surface: Attachment<HTMLElement> = (el) => {
		surfaceEl = el;
		return () => {
			if (surfaceEl === el) surfaceEl = null;
		};
	};

	return {
		get depth() {
			return depth < 0 ? 0 : depth;
		},
		get topmost() {
			return topmost;
		},
		surface
	};
}
