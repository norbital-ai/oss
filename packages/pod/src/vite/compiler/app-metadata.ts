import { parse, type AST } from 'svelte/compiler';
import { sourceDiagnostic } from './diagnostics.js';
import type { AppMetadata, StructuralDiagnostic } from './types.js';

interface AppMetadataResult {
	readonly metadata: AppMetadata | null;
	readonly diagnostics: readonly StructuralDiagnostic[];
}

type MetadataEntry = { value: string | null; element: AST.RegularElement };

function staticText(nodes: readonly AST.TemplateNode[]): string | null {
	if (!nodes.every((node): node is AST.Text => node.type === 'Text')) return null;
	return nodes
		.map((node) => node.data)
		.join('')
		.trim();
}

function staticAttribute(element: AST.RegularElement, name: string): string | null {
	const attribute = element.attributes
		.filter((candidate) => candidate.type === 'Attribute')
		.find((candidate) => candidate.name === name);
	if (!attribute || attribute.value === true || !Array.isArray(attribute.value)) return null;
	return staticText(attribute.value);
}

function extractAppIcon(
	source: string,
	file: string,
	headOffset: number,
	entries: readonly MetadataEntry[]
): { icon: string | null; diagnostics: readonly StructuralDiagnostic[] } {
	const diagnostics: StructuralDiagnostic[] = [];
	if (entries.length === 0) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				headOffset,
				'APP_ICON_MISSING',
				'App head requires one static pod:icon meta tag'
			)
		);
	}
	for (const entry of entries.slice(1)) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				entry.element.start,
				'APP_ICON_DUPLICATE',
				'App head must contain only one pod:icon meta tag'
			)
		);
	}
	const icon = entries[0]?.value ?? null;
	if (entries[0] && !icon) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				entries[0].element.start,
				'APP_ICON_DYNAMIC',
				'App icon must be a non-empty static string'
			)
		);
	}
	return { icon, diagnostics };
}

/**
 * Lightweight static-meta reader for non-app roles (e.g. `+representation.svelte`).
 *
 * Returns the literal `content` of the first `<meta name="{name}" …>` whose value is a static
 * non-empty string, or `null`. Unlike `extractAppMetadata` it does not diagnose or require a
 * title/icon — a banner is an optional decoration, not identity.
 */
export function extractStaticMetaValue(source: string, name: string): string | null {
	let root: AST.Root;
	try {
		root = parse(source, { modern: true });
	} catch {
		return null;
	}
	for (const head of root.fragment.nodes) {
		if (head.type !== 'SvelteHead') continue;
		for (const node of head.fragment.nodes) {
			if (node.type !== 'RegularElement' || node.name !== 'meta') continue;
			const metaName = staticAttribute(node, 'name');
			if (metaName !== name) continue;
			const content = staticAttribute(node, 'content');
			if (!content) return null;
			return content;
		}
	}
	return null;
}

export function extractAppMetadata(source: string, file: string): AppMetadataResult {
	let root: AST.Root;
	try {
		root = parse(source, { filename: file, modern: true });
	} catch (error) {
		return {
			metadata: null,
			diagnostics: [
				sourceDiagnostic(
					source,
					file,
					0,
					'APP_PARSE_ERROR',
					error instanceof Error ? error.message : 'Unable to parse Svelte app'
				)
			]
		};
	}

	const heads = root.fragment.nodes.filter(
		(node): node is AST.SvelteHead => node.type === 'SvelteHead'
	);
	const diagnostics: StructuralDiagnostic[] = [];
	const titleNodes = heads.flatMap((head) =>
		head.fragment.nodes.filter((node): node is AST.TitleElement => node.type === 'TitleElement')
	);
	if (titleNodes.length === 0) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				heads[0]?.start ?? 0,
				'APP_TITLE_MISSING',
				'App head requires one static <title>'
			)
		);
	}
	if (titleNodes.length > 1) {
		for (const title of titleNodes.slice(1)) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					title.start,
					'APP_TITLE_DUPLICATE',
					'App head must contain only one <title>'
				)
			);
		}
	}
	const title = titleNodes[0] ? staticText(titleNodes[0].fragment.nodes) : null;
	if (titleNodes[0] && !title) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				titleNodes[0].start,
				'APP_TITLE_DYNAMIC',
				'App title must be a non-empty static string'
			)
		);
	}

	const metadataElements = heads.flatMap((head) =>
		head.fragment.nodes
			.filter((node) => node.type === 'RegularElement')
			.filter((node) => node.name === 'meta')
	);
	const values = new Map<
		'description' | 'pod:icon' | 'pod:thumbnail' | 'pod:banner',
		MetadataEntry[]
	>();
	for (const element of metadataElements) {
		const name = staticAttribute(element, 'name');
		if (
			name !== 'description' &&
			name !== 'pod:icon' &&
			name !== 'pod:thumbnail' &&
			name !== 'pod:banner'
		) {
			continue;
		}
		const entries = values.get(name) ?? [];
		entries.push({ value: staticAttribute(element, 'content'), element });
		values.set(name, entries);
	}

	const iconResult = extractAppIcon(
		source,
		file,
		heads[0]?.start ?? 0,
		values.get('pod:icon') ?? []
	);
	diagnostics.push(...iconResult.diagnostics);

	const descriptionEntries = values.get('description') ?? [];
	// An app with nothing said about it is the one thing the studio cannot compensate for: the title
	// names the surface and the icon decorates it, and neither says what the app is for.
	if (descriptionEntries.length === 0) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				heads[0]?.start ?? 0,
				'APP_DESCRIPTION_MISSING',
				'App head requires one static description meta tag'
			)
		);
	}
	for (const entry of descriptionEntries.slice(1)) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				entry.element.start,
				'APP_DESCRIPTION_DUPLICATE',
				'App head must contain only one description meta tag'
			)
		);
	}
	if (descriptionEntries[0] && !descriptionEntries[0].value) {
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				descriptionEntries[0].element.start,
				'APP_DESCRIPTION_DYNAMIC',
				'App description must be a non-empty static string'
			)
		);
	}

	for (const [name, label] of [
		['pod:thumbnail', 'thumbnail'],
		['pod:banner', 'banner']
	] as const) {
		const entries = values.get(name) ?? [];
		for (const entry of entries.slice(1)) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					entry.element.start,
					`APP_${label.toUpperCase()}_DUPLICATE`,
					`App head must contain only one ${name} meta tag`
				)
			);
		}
		if (entries[0] && !entries[0].value) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					entries[0].element.start,
					`APP_${label.toUpperCase()}_DYNAMIC`,
					`App ${label} must be a non-empty static URL`
				)
			);
		}
	}

	const thumbnail = values.get('pod:thumbnail')?.[0]?.value ?? null;
	const banner = values.get('pod:banner')?.[0]?.value ?? null;
	return {
		metadata:
			diagnostics.length === 0 && title && iconResult.icon && descriptionEntries[0]?.value
				? {
						title,
						description: descriptionEntries[0].value,
						icon: iconResult.icon,
						thumbnail,
						banner
					}
				: null,
		diagnostics
	};
}
