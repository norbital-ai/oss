import type { DocTocItem } from '#lib/doc-toc/types';

export const DEFAULT_DOC_TOC_HEADINGS = 'h1[id], h2[id], h3[id]';
export const FEATURE_DOC_TOC_HEADINGS = 'h2[id], h3[id]';

function headingDepth(tagName: string): number {
	const level = Number.parseInt(tagName.charAt(1), 10);
	if (level >= 1 && level <= 6) return level;
	return 2;
}

export function syncDocTocHeadings(
	article: HTMLElement | null,
	selector: string = DEFAULT_DOC_TOC_HEADINGS
): DocTocItem[] {
	if (!article) return [];

	return [...article.querySelectorAll<HTMLElement>(selector)].map((heading) => ({
		url: `#${heading.id}`,
		title: heading.textContent?.trim() ?? '',
		depth: headingDepth(heading.tagName)
	}));
}
