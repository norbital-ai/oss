import type { DocTocItem } from './types';

export type DocTocPosition = [top: number, bottom: number] | null;

export function measureDocTocItemPositions(
	container: HTMLElement,
	items: DocTocItem[]
): DocTocPosition[] {
	return items.map((item) => {
		const link = container.querySelector<HTMLElement>(`a[href="${CSS.escape(item.url)}"]`);
		if (!link) return null;

		const styles = getComputedStyle(link);
		return [
			link.offsetTop + Number.parseFloat(styles.paddingTop),
			link.offsetTop + link.clientHeight - Number.parseFloat(styles.paddingBottom)
		];
	});
}
