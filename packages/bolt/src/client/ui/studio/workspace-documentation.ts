import { Result } from 'effect';

export type WorkspaceDocumentationPage = Readonly<{
	path: string;
	title: string;
}>;

type WorkspaceDocumentationNavigation =
	| Readonly<{ kind: 'document'; path: string; heading: string }>
	| Readonly<{ kind: 'source'; path: string }>;

type MarkdownHrefKind = 'link' | 'image';

const LOCALIZED_MARKDOWN_PATH = /^(.*)\.(en|zh)\.md$/i;
const EXTERNAL_WEB_HREF = /^https?:\/\//i;
const EXPLICIT_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;

const canonicalDocumentationPath = (path: string): string => {
	const match = LOCALIZED_MARKDOWN_PATH.exec(path);
	return match === null ? path : `${match[1]}.md`;
};

const documentationCandidate = (path: string): boolean => {
	const canonical = canonicalDocumentationPath(path);
	return canonical === 'README.md' || (canonical.startsWith('docs/') && canonical.endsWith('.md'));
};

const localeLanguage = (locale: string): 'en' | 'zh' =>
	locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';

const localizedPath = (canonical: string, language: 'en' | 'zh'): string =>
	canonical.replace(/\.md$/i, `.${language}.md`);

const selectedLocalizedPath = (
	canonical: string,
	paths: readonly string[],
	locale: string
): string => {
	const language = localeLanguage(locale);
	if (language !== 'en') {
		const localized = localizedPath(canonical, language);
		if (paths.includes(localized)) return localized;
	}
	if (paths.includes(canonical)) return canonical;
	const english = localizedPath(canonical, 'en');
	return paths.includes(english) ? english : ([...paths].sort()[0] ?? canonical);
};

const fallbackDocumentationTitle = (path: string): string => {
	const parts = canonicalDocumentationPath(path).split('/');
	const file = parts.at(-1) ?? path;
	const subject =
		file.toLowerCase() === 'readme.md' && parts.length > 1
			? (parts.at(-2) ?? 'Overview')
			: file.replace(/\.md$/i, '');
	return subject
		.replace(/[-_]+/g, ' ')
		.replace(/\b\p{L}/gu, (character) => character.toUpperCase());
};

const markdownHeadingText = (value: string): string =>
	value
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]*>/g, '')
		.replace(/[`*_~]/g, '')
		.trim();

const workspaceDocumentationTitle = (path: string, contents: string): string => {
	const heading = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(contents)?.[1];
	const title = heading === undefined ? '' : markdownHeadingText(heading);
	return title || fallbackDocumentationTitle(path);
};

/** Root README plus every markdown page under docs/, localized as one page per source document. */
export const workspaceDocumentationPages = (
	files: Readonly<Record<string, string>>,
	locale: string
): WorkspaceDocumentationPage[] => {
	const grouped = new Map<string, string[]>();
	for (const path of Object.keys(files)) {
		if (!documentationCandidate(path)) continue;
		const canonical = canonicalDocumentationPath(path);
		grouped.set(canonical, [...(grouped.get(canonical) ?? []), path]);
	}

	return [...grouped.entries()]
		.sort(([left], [right]) => {
			if (left === 'README.md') return -1;
			if (right === 'README.md') return 1;
			return left.localeCompare(right);
		})
		.map(([canonical, paths]) => {
			const path = selectedLocalizedPath(canonical, paths, locale);
			return { path, title: workspaceDocumentationTitle(path, files[path] ?? '') };
		});
};

export const selectedWorkspaceDocumentationPath = (
	pages: readonly WorkspaceDocumentationPage[],
	requested: string
): string => {
	const first = pages[0];
	if (first === undefined) return '';
	const direct = pages.find((page) => page.path === requested);
	if (direct !== undefined) return direct.path;
	const canonical = canonicalDocumentationPath(requested);
	return (
		pages.find((page) => canonicalDocumentationPath(page.path) === canonical)?.path ?? first.path
	);
};

const decodedPath = (path: string): string | null =>
	Result.getOrElse(
		Result.try(() => decodeURIComponent(path)),
		() => null
	);

const resolveRelativePath = (from: string, relative: string): string | null => {
	const decoded = decodedPath(relative.replace(/^\.\//, ''));
	if (decoded === null || decoded.startsWith('/')) return null;
	const parts = from.split('/').slice(0, -1);
	for (const part of decoded.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join('/');
};

const workspaceDocumentHref = (path: string, heading: string): string => {
	const params = new URLSearchParams({ 'workspace-document': path });
	if (heading !== '') params.set('heading', heading);
	return `#${params.toString()}`;
};

const workspaceSourceHref = (path: string): string =>
	`#${new URLSearchParams({ 'workspace-source': path }).toString()}`;

const documentAtPath = (
	pages: readonly WorkspaceDocumentationPage[],
	path: string
): WorkspaceDocumentationPage | undefined => {
	const candidates = [path, `${path}.md`, `${path.replace(/\/$/, '')}/README.md`];
	for (const candidate of candidates) {
		const direct = pages.find((page) => page.path === candidate);
		if (direct !== undefined) return direct;
		const canonical = canonicalDocumentationPath(candidate);
		const localized = pages.find((page) => canonicalDocumentationPath(page.path) === canonical);
		if (localized !== undefined) return localized;
	}
	return undefined;
};

export const resolveWorkspaceDocumentationHref = (input: {
	currentPath: string;
	href: string;
	kind: MarkdownHrefKind;
	files: Readonly<Record<string, string>>;
	pages: readonly WorkspaceDocumentationPage[];
}): string | null => {
	const { currentPath, href, kind, files, pages } = input;
	if (href === '') return null;
	if (href.startsWith('#')) return kind === 'link' ? href : null;
	if (EXTERNAL_WEB_HREF.test(href)) return href;
	if (kind === 'link' && (href.startsWith('mailto:') || href.startsWith('tel:'))) return href;
	if (href.startsWith('/') && !href.startsWith('//')) return href;
	if (href.startsWith('//') || EXPLICIT_PROTOCOL.test(href)) return null;

	const hashIndex = href.indexOf('#');
	const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
	const heading = hashIndex === -1 ? '' : (decodedPath(href.slice(hashIndex + 1)) ?? '');
	const relative = beforeHash.split('?')[0] ?? '';
	const path = resolveRelativePath(currentPath, relative);
	if (path === null) return null;

	if (kind === 'image') {
		const contents = files[path];
		if (contents === undefined || !path.toLowerCase().endsWith('.svg')) return null;
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(contents)}`;
	}

	const page = documentAtPath(pages, path);
	if (page !== undefined) {
		if (page.path === currentPath && heading !== '') return `#${heading}`;
		return workspaceDocumentHref(page.path, heading);
	}
	return Object.hasOwn(files, path) ? workspaceSourceHref(path) : null;
};

export const documentationNavigationFromHref = (
	href: string
): WorkspaceDocumentationNavigation | null => {
	if (!href.startsWith('#workspace-')) return null;
	const params = new URLSearchParams(href.slice(1));
	const documentPath = params.get('workspace-document');
	if (documentPath !== null) {
		return { kind: 'document', path: documentPath, heading: params.get('heading') ?? '' };
	}
	const sourcePath = params.get('workspace-source');
	return sourcePath === null ? null : { kind: 'source', path: sourcePath };
};
