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
	}

	watch(options?: IntersectionObserverInit): void {
		if (this.observer) return;

		this.observer = new IntersectionObserver(this.callback.bind(this), options);
		this.observeItems();
	}

	unwatch(): void {
		this.observer?.disconnect();
		this.observer = null;
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
		this.items = next;
		for (const listener of this.listeners) listener(next);
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
