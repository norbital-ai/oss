import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes the API-docs manifest for the committed `docs/api-reference` tree.
 *
 * Typedoc emits the markdown; this script scans it and writes `manifest.json` next to it. The
 * whole tree is committed to the repository, and the public website fetches it from GitHub
 * rather than generating or reading anything locally.
 */
const OUTPUT_DIR = path.resolve('docs/api-reference');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');
const PACKAGE_SCOPE = '@norbital-ai';

/** @typedef {{ title: string; slug: string; href: string }} ApiDocNavItem */

/** @typedef {{ id: string; title: string; slug: string; href: string; children: ApiDocNavItem[] }} ApiDocPackage */

/** @typedef {{ generatedAt: string; packages: ApiDocPackage[]; pages: ApiDocNavItem[] }} ApiDocsManifest */

function stripTypedocPreamble(markdown) {
	const match = markdown.match(/^#\s/m);
	if (!match || match.index == null) {
		return markdown;
	}
	return markdown.slice(match.index);
}

function extractTitle(markdown) {
	const heading = /^#\s+(.+)$/m.exec(stripTypedocPreamble(markdown));
	return heading?.[1]?.trim() ?? 'Untitled';
}

function slugFromRelativePath(relativePath) {
	const normalized = relativePath.replace(/\\/g, '/').replace(/\.md$/, '');
	if (normalized === 'README') {
		return '';
	}
	return normalized.replace(/\/README$/, '');
}

function hrefFromSlug(slug) {
	if (!slug) {
		return '/docs/api-reference';
	}
	return `/docs/api-reference/${slug}`;
}

function normalizeMarkdown(filePath) {
	const markdown = fs.readFileSync(filePath, 'utf8');
	const normalized = markdown.replace(/[\t ]+$/gm, '');
	if (normalized !== markdown) fs.writeFileSync(filePath, normalized);
	return normalized;
}

/** @returns {string[]} */
function listMarkdownFiles(directory) {
	return fs
		.readdirSync(directory, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/** @returns {ApiDocNavItem[]} */
function parseModuleLinks(readmeMarkdown) {
	const modulesSection = readmeMarkdown.match(/## Modules\n([\s\S]*?)(?:\n## |\n*$)/);
	if (!modulesSection) {
		return [];
	}

	/** @type {ApiDocNavItem[]} */
	const children = [];
	for (const match of modulesSection[1].matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
		const label = match[1];
		const linkTarget = match[2];
		const slug = linkTarget
			.replace(/^\/docs\/api-reference\//, '')
			.replace(/\.md$/, '')
			.replace(/\/README$/, '');
		children.push({
			title: label,
			slug,
			href: hrefFromSlug(slug)
		});
	}
	return children;
}

/**
 * The module pages under one package directory, titled from the scan where the scan saw them.
 *
 * The fallback is for a page the scan missed: its filename stands in for a heading.
 *
 * @param {string} packageDirectory
 * @param {Map<string, ApiDocNavItem>} pagesBySlug
 * @returns {ApiDocNavItem[]}
 */
function listModulePages(packageDirectory, pagesBySlug) {
	/** @type {ApiDocNavItem[]} */
	const pages = [];
	for (const filePath of listMarkdownFiles(packageDirectory)) {
		if (filePath.endsWith('README.md')) {
			continue;
		}
		const slug = slugFromRelativePath(path.relative(OUTPUT_DIR, filePath));
		pages.push(
			pagesBySlug.get(slug) ?? {
				title: path.basename(filePath, '.md'),
				slug,
				href: hrefFromSlug(slug)
			}
		);
	}
	return pages.sort((left, right) => left.title.localeCompare(right.title));
}

function main() {
	if (!fs.existsSync(OUTPUT_DIR)) {
		throw new Error(`Missing API docs output at ${OUTPUT_DIR}. Run typedoc first.`);
	}

	/** @type {Map<string, ApiDocNavItem>} */
	const pagesBySlug = new Map();

	for (const absolutePath of listMarkdownFiles(OUTPUT_DIR)) {
		const relativePath = path.relative(OUTPUT_DIR, absolutePath);
		const slug = slugFromRelativePath(relativePath);
		const markdown = normalizeMarkdown(absolutePath);
		pagesBySlug.set(slug, {
			title: extractTitle(markdown),
			slug,
			href: hrefFromSlug(slug)
		});
	}

	const packageRoot = OUTPUT_DIR;
	/** @type {ApiDocPackage[]} */
	const packages = [];

	for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		const packageId = `${PACKAGE_SCOPE}/${entry.name}`;
		const readmePath = path.join(packageRoot, entry.name, 'README.md');
		const readmeMarkdown = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
		const packageSlug = entry.name;
		const children = readmeMarkdown
			? parseModuleLinks(readmeMarkdown)
			: listModulePages(path.join(packageRoot, entry.name), pagesBySlug);

		packages.push({
			id: packageId,
			title: packageId,
			slug: packageSlug,
			href: hrefFromSlug(packageSlug),
			children
		});
	}

	packages.sort((left, right) => left.title.localeCompare(right.title));

	/** @type {ApiDocsManifest} */
	const manifest = {
		generatedAt: new Date().toISOString(),
		packages,
		pages: [...pagesBySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug))
	};

	fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`[api-docs] Wrote ${manifest.pages.length} pages to ${MANIFEST_PATH}`);
}

main();
