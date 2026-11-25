// Page-wide modal side effects with reference counting so stacked dialogs/drawers never clobber
// each other: `inert_outside` hides background siblings from pointer/keyboard/screen readers while
// exempting live regions, and `lock_scroll` freezes document scroll without horizontal layout shift.

type ModalShared = {
	readonly scrollHolders: WeakMap<Document, Set<object>>;
	readonly scrollRestore: WeakMap<Document, () => void>;
	readonly inertCounts: WeakMap<HTMLElement, number>;
};

const shared: ModalShared = {
	scrollHolders: new WeakMap(),
	scrollRestore: new WeakMap(),
	inertCounts: new WeakMap()
};

function getShared(): ModalShared {
	return shared;
}

function setStyleProperty(el: HTMLElement, prop: string, value: string): () => void {
	const prevValue = el.style.getPropertyValue(prop);
	const prevPriority = el.style.getPropertyPriority(prop);
	el.style.setProperty(prop, value);
	return () => {
		if (prevValue === '') el.style.removeProperty(prop);
		else el.style.setProperty(prop, prevValue, prevPriority);
	};
}

function isLiveRegion(el: Element): boolean {
	if (el.hasAttribute('data-norbital-announcer')) return true;
	const live = el.getAttribute('aria-live');
	return live === 'polite' || live === 'assertive';
}

function freezeDocumentScroll(doc: Document): () => void {
	const root = doc.documentElement;
	const body = doc.body;
	if (body === null) return () => {};
	const win = doc.defaultView;
	const scrollbarWidth =
		win !== null ? Math.max(0, win.innerWidth - root.clientWidth) : 0;
	const supportsGutter =
		typeof CSS !== 'undefined' &&
		typeof CSS.supports === 'function' &&
		CSS.supports('scrollbar-gutter', 'stable');

	const restores: (() => void)[] = [
		setStyleProperty(body, 'overflow', 'hidden'),
		setStyleProperty(root, 'scroll-behavior', 'auto')
	];
	if (scrollbarWidth > 0) {
		if (supportsGutter) {
			restores.push(setStyleProperty(root, 'scrollbar-gutter', 'stable'));
		} else {
			const pad = Number.parseFloat(getComputedStyle(body).paddingRight) || 0;
			restores.push(setStyleProperty(body, 'padding-right', `${pad + scrollbarWidth}px`));
		}
	}
	return () => {
		for (let i = restores.length - 1; i >= 0; i--) restores[i]?.();
	};
}

/**
 * Reference-counted document scroll lock. The first holder freezes the scroller without horizontal
 * gutter shift; only the last release restores styles. Safe to call release multiple times.
 */
export function lock_scroll(
	doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): () => void {
	if (doc === undefined) return () => {};
	const shared = getShared();
	const token = {};
	let holders = shared.scrollHolders.get(doc);
	if (holders === undefined) {
		holders = new Set();
		shared.scrollHolders.set(doc, holders);
	}
	if (holders.size === 0) {
		shared.scrollRestore.set(doc, freezeDocumentScroll(doc));
	}
	holders.add(token);

	return () => {
		if (!holders.delete(token)) return;
		if (holders.size > 0) return;
		shared.scrollRestore.get(doc)?.();
		shared.scrollRestore.delete(doc);
	};
}

/** Handle returned by `inert_outside` allowing portaled child popups to stay interactive. */
export type InertHandle = (() => void) & {
	/** Exempts an additional element (e.g. a popover portaled into `document.body`) while active. */
	readonly keep: (el: HTMLElement) => () => void;
};

function applyInert(keep: readonly Element[]): () => void {
	const shared = getShared();
	const keepSet = new Set<Element>();
	for (const target of keep) {
		let cur: Element | null = target;
		while (cur !== null) {
			keepSet.add(cur);
			cur = cur.parentElement;
		}
	}

	const changed: HTMLElement[] = [];
	const visitedParents = new Set<ParentNode>();
	for (const node of keepSet) {
		const parent = node.parentNode;
		if (parent === null || visitedParents.has(parent)) continue;
		visitedParents.add(parent);
		for (const child of Array.from(parent.children)) {
			if (keepSet.has(child) || !(child instanceof HTMLElement)) continue;
			if (isLiveRegion(child) || child.querySelector('[data-norbital-announcer]') !== null) continue;
			const count = shared.inertCounts.get(child) ?? (child.inert ? Number.POSITIVE_INFINITY : 0);
			if (count === 0) child.inert = true;
			if (Number.isFinite(count)) shared.inertCounts.set(child, count + 1);
			changed.push(child);
		}
	}

	return () => {
		for (const el of changed) {
			const count = shared.inertCounts.get(el);
			if (count === undefined) continue;
			if (count <= 1) {
				el.inert = false;
				shared.inertCounts.delete(el);
			} else {
				shared.inertCounts.set(el, count - 1);
			}
		}
	};
}

/**
 * Marks every sibling tree outside `keep` as `inert` (ref-counted across nested modals) while
 * keeping live announcer regions active. Call `.keep(el)` to exempt a portaled overlay opened inside.
 */
export function inert_outside(keep: HTMLElement | readonly HTMLElement[]): InertHandle {
	let current: HTMLElement[] = Array.isArray(keep) ? [...keep] : [keep];
	let release = applyInert(current);
	let done = false;

	const swap = (next: HTMLElement[]) => {
		const prev = release;
		current = next;
		release = applyInert(next);
		prev();
	};

	const stop = () => {
		if (done) return;
		done = true;
		release();
	};

	return Object.assign(stop, {
		keep(el: HTMLElement): () => void {
			if (done) return () => {};
			if (!current.includes(el)) swap([...current, el]);
			return () => {
				if (!done) swap(current.filter((node) => node !== el));
			};
		}
	});
}
