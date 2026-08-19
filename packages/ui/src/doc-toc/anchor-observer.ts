import type { DocTocItem, DocTocItemInfo, DocTocTrackBounds } from './types';

export type DocTocChangeListener = (items: DocTocItemInfo[]) => void;

/** IntersectionObserver rootMargin only accepts px or % — not rem. */
export function buildDocTocRootMargin(topRem = 4, bottomPercent = 55): string {
	const rootFontSize =
		typeof document === 'undefined'
			? 16
			: parseFloat(getComputedStyle(document.documentElement).fontSize);
	return `-${topRem * rootFontSize}px 0px -${bottomPercent}% 0px`;
}

function getItemId(url: string): string | null {
	if (url.startsWith('#')) return url.slice(1);
	return null;
}

function findLastActiveIndex(items: DocTocItemInfo[]): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].active) return i;
	}
	return -1;
}

export class DocTocAnchorObserver {
	items: DocTocItemInfo[] = [];

	private observer: IntersectionObserver | null = null;
	private readonly listeners = new Set<DocTocChangeListener>();
	/** The scrollport the headings move through — the document unless a `root` was given. */
	private scrollRoot: Element | null = null;
	private atEnd = false;
	private readonly onScroll = () => this.syncEnd();

	listen(listener: DocTocChangeListener): void {
		this.listeners.add(listener);
	}

	unlisten(listener: DocTocChangeListener): void {
		this.listeners.delete(listener);
	}

	setItems(newItems: DocTocItem[]): void {
		if (this.observer) {
			for (const item of this.items) {
				const element = document.getElementById(item.id);
				if (element) this.observer.unobserve(element);
			}
		}

		const next: DocTocItemInfo[] = [];
		for (const item of newItems) {
			const id = getItemId(item.url);
			if (!id) continue;

			next.push({
				id,
				active: false,
				fallback: false,
				t: 0,
				original: item
			});
		}

		this.update(next);
		this.observeItems();
		// Headings syncing means the article has laid out. The measurement taken in `watch()` ran
		// before that, when `scrollHeight` was still viewport-sized and *every* page reported
		// itself at its end.
		if (this.observer) this.syncEnd();
	}

	watch(options?: IntersectionObserverInit): void {
		if (this.observer) return;

		this.observer = new IntersectionObserver(this.callback.bind(this), options);
		this.observeItems();

		// A heading only counts as active inside the observer's band — roughly the top 45% of the
		// viewport. The *last* heading on a page can never get there when the content beneath it is
		// shorter than the rest of the screen: you scroll to the very bottom and the entry stays
		// grey, with nothing left to scroll that would fix it. Pages worked around it with bottom
		// padding, which has to be re-tuned per page and still fails whenever a final section is
		// short.
		//
		// Scroll position answers it exactly. At the foot of the scrollport the last heading is what
		// the reader is looking at, whatever the band says, so that is what the rail shows.
		if (typeof window === 'undefined') return;
		this.scrollRoot = options?.root instanceof Element ? options.root : null;
		const target: EventTarget = this.scrollRoot ?? window;
		target.addEventListener('scroll', this.onScroll, { passive: true });
		window.addEventListener('resize', this.onScroll, { passive: true });
		this.syncEnd();
	}

	unwatch(): void {
		this.observer?.disconnect();
		this.observer = null;

		if (typeof window === 'undefined') return;
		const target: EventTarget = this.scrollRoot ?? window;
		target.removeEventListener('scroll', this.onScroll);
		window.removeEventListener('resize', this.onScroll);
		this.scrollRoot = null;
		this.atEnd = false;
	}

	/** Recompute "is the scrollport at its end", and re-emit only when the answer changed. */
	private syncEnd(): void {
		const root = this.scrollRoot ?? document.documentElement;
		const viewport = this.scrollRoot ? root.clientHeight : window.innerHeight;
		const offset = this.scrollRoot ? root.scrollTop : window.scrollY;
		// A fractional layout leaves a sub-pixel remainder at a true end, so the check has slack.
		const atEnd = offset + viewport >= root.scrollHeight - 2;
		if (atEnd === this.atEnd) return;
		this.atEnd = atEnd;
		this.update(this.items);
	}

	private callback(entries: IntersectionObserverEntry[]): void {
		if (entries.length === 0) return;

		let hasActive = false;
		const updated = this.items.map((item) => {
			const entry = entries.find((candidate) => candidate.target.id === item.id);
			const active = entry ? entry.isIntersecting : item.active && !item.fallback;

			if (item.active !== active) {
				item = {
					...item,
					t: Date.now(),
					active,
					fallback: false
				};
			}

			if (active) hasActive = true;
			return item;
		});

		if (!hasActive && entries[0].rootBounds) {
			const viewTop = entries[0].rootBounds.top;
			let min = Number.MAX_VALUE;
			let fallbackIdx = -1;

			for (let i = 0; i < updated.length; i++) {
				const element = document.getElementById(updated[i].id);
				if (!element) continue;

				const distance = Math.abs(viewTop - element.getBoundingClientRect().top);
				if (distance < min) {
					fallbackIdx = i;
					min = distance;
				}
			}

			if (fallbackIdx !== -1) {
				updated[fallbackIdx] = {
					...updated[fallbackIdx],
					active: true,
					fallback: true,
					t: Date.now()
				};
			}
		}

		this.update(updated);
	}

	private observeItems(): void {
		if (!this.observer) return;

		for (const item of this.items) {
			const element = document.getElementById(item.id);
			if (element) this.observer.observe(element);
		}
	}

	private update(next: DocTocItemInfo[]): void {
		// `items` keeps what the intersections say, so scrolling back up restores it untouched; the
		// end-of-scroll override is applied only on the way out to listeners.
		this.items = next;
		const projected = this.project(next);
		for (const listener of this.listeners) listener(projected);
	}

	/**
	 * Always a fresh array, even when nothing is overridden.
	 *
	 * The consumer assigns this straight into `$state`, and assigning the identical reference is a
	 * no-op there — so returning `items` unchanged when the override switched *off* left the last
	 * entry highlighted after the reader scrolled back up. Turning a highlight on is only half the
	 * behaviour; turning it off has to re-render too.
	 */
	private project(items: DocTocItemInfo[]): DocTocItemInfo[] {
		const lastIndex = items.length - 1;
		if (!this.atEnd || lastIndex < 0 || items[lastIndex].active) return [...items];

		const now = Date.now();
		return items.map((item, index) =>
			index === lastIndex
				? { ...item, active: true, fallback: true, t: now }
				: item.active
					? { ...item, active: false, fallback: false, t: now }
					: item
		);
	}
}

export function findLastActiveDocTocIndex(items: DocTocItemInfo[]): number {
	return findLastActiveIndex(items);
}

export function getActiveDocTocItem(items: DocTocItemInfo[]): DocTocItemInfo | undefined {
	let active: DocTocItemInfo | undefined;

	for (const item of items) {
		if (!item.active) continue;
		if (!active || item.t > active.t) active = item;
	}

	return active;
}

export function computeDocTocTrackBounds(
	positions: Array<[top: number, bottom: number] | null>,
	items: DocTocItemInfo[]
): DocTocTrackBounds | null {
	const startIdx = items.findIndex((item) => item.active);
	if (startIdx === -1) return null;

	const endIdx = findLastActiveIndex(items);
	const start = positions[startIdx];
	const end = positions[endIdx];
	if (!start || !end || end[1] <= start[0]) return null;

	return { top: start[0], bottom: end[1] };
}

export function scrollDocTocLinkIntoView(link: HTMLElement, container: HTMLElement): void {
	const linkRect = link.getBoundingClientRect();
	const containerRect = container.getBoundingClientRect();

	if (linkRect.top < containerRect.top) {
		container.scrollTop -= containerRect.top - linkRect.top;
	} else if (linkRect.bottom > containerRect.bottom) {
		container.scrollTop += linkRect.bottom - containerRect.bottom;
	}
}
