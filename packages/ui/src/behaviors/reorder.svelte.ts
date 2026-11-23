// Pointer + keyboard list reordering over ordered string keys.
// Supports HTML drag-and-drop AND accessible keyboard reordering (Alt+ArrowUp/Down/Left/Right).

/** Axis for keyboard reordering (`'vertical'` or `'horizontal'`). */
export type ReorderOrientation = 'vertical' | 'horizontal';

/** Options for `create_reorder`. */
export type ReorderOptions = {
	/** Ordered item keys. */
	items: () => readonly string[];
	/** Invoked with `(fromIndex, toIndex, nextOrder)` when an item moves. */
	on_reorder: (from: number, to: number, next: readonly string[]) => void;
	/** Axis for keyboard movement (default `'vertical'`). */
	orientation?: ReorderOrientation;
	/** Disable reordering globally or for a specific key. */
	disabled?: boolean | ((key: string) => boolean);
};

/** Return value of `create_reorder`. */
export type Reorder = ReturnType<typeof create_reorder>;

/** Returns a new array with the item at `from` moved to `to`. */
export function move_item<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
		return [...list];
	}
	const next = [...list];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) next.splice(to, 0, moved);
	return next;
}

/**
 * Headless pointer + keyboard reordering behavior for queues, lanes, checklists and builders.
 * Spread `item_attrs(key)` onto each item for `draggable`, `data-dragging`, `data-drop-target`
 * and drag/Alt+Arrow handlers.
 * @example
 * const reorder = create_reorder({
 *   items: () => queue.map((item) => item.id),
 *   on_reorder: (_from, _to, nextIds) => persistOrder(nextIds)
 * });
 * // {#each queue as item (item.id)}
 * //   <div {...reorder.item_attrs(item.id)}>{item.title}</div>
 * // {/each}
 */
export function create_reorder(options: ReorderOptions) {
	let dragging = $state<string | null>(null);
	let over = $state<string | null>(null);

	const isDisabled = (key: string) =>
		typeof options.disabled === 'function' ? options.disabled(key) : (options.disabled ?? false);

	function commit(fromIndex: number, toIndex: number): void {
		const list = options.items();
		if (fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) return;
		if (fromIndex === toIndex) return;
		options.on_reorder(fromIndex, toIndex, move_item(list, fromIndex, toIndex));
	}

	function move_by(key: string, delta: number): void {
		if (isDisabled(key)) return;
		const list = options.items();
		const from = list.indexOf(key);
		if (from < 0) return;
		const to = Math.max(0, Math.min(list.length - 1, from + delta));
		commit(from, to);
	}

	return {
		get dragging() {
			return dragging;
		},
		get over() {
			return over;
		},
		move(fromIndex: number, toIndex: number) {
			commit(fromIndex, toIndex);
		},
		move_by,
		item_attrs(key: string) {
			const off = isDisabled(key);
			const prevKey = options.orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
			const nextKey = options.orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
			return {
				draggable: !off,
				'data-dragging': dragging === key ? '' : undefined,
				'data-drop-target': over === key && dragging !== key ? '' : undefined,
				ondragstart: (event: DragEvent) => {
					if (off) {
						event.preventDefault();
						return;
					}
					dragging = key;
					if (event.dataTransfer) {
						event.dataTransfer.effectAllowed = 'move';
						event.dataTransfer.setData('text/plain', key);
					}
				},
				ondragover: (event: DragEvent) => {
					if (dragging === null || off) return;
					event.preventDefault();
					if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
					if (over !== key) over = key;
				},
				ondragleave: () => {
					if (over === key) over = null;
				},
				ondrop: (event: DragEvent) => {
					if (dragging === null || off) return;
					event.preventDefault();
					const list = options.items();
					const from = list.indexOf(dragging);
					const to = list.indexOf(key);
					dragging = null;
					over = null;
					commit(from, to);
				},
				ondragend: () => {
					dragging = null;
					over = null;
				},
				onkeydown: (event: KeyboardEvent) => {
					if (off || !event.altKey) return;
					if (event.key === prevKey) {
						event.preventDefault();
						move_by(key, -1);
					} else if (event.key === nextKey) {
						event.preventDefault();
						move_by(key, 1);
					}
				}
			};
		}
	};
}
