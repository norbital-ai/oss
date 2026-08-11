import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceDiagnostic } from './diagnostics.js';
import { safeParse } from '@norbital-ai/std/json';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@norbital-ai/std/i18n';
import { nearestName } from '@norbital-ai/std/string';
import { extractAppMetadata, extractStaticMetaValue } from './app-metadata.js';
import { parseSkillDocument } from './skill-frontmatter.js';
import { HOST_SKILLS } from '$lib/skills/skills.generated.js';
import { isValidSkillName } from '$lib/skills/types.js';
import type {
	DiagnosticSnapshot,
	DiscoveredAppNode,
	DiscoveredCollection,
	DiscoveredCustomType,
	DiscoveredI18n,
	DiscoveredSkill,
	DiscoveredWorkspaceRole,
	PodFilesystemCompilation,
	PodFilesystemCompilerOptions,
	PodStructure,
	StructuralDiagnostic
} from './types.js';

const COLLECTION_ROLE_FILES = [
	'+model.ts',
	'+hooks.ts',
	'+pipelines.ts',
	'+integrations.ts',
	'+representation.svelte'
] as const;
const PRIVATE_VIRTUAL_IMPORT_PATTERN =
	/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']virtual:pod\/[^"']+["']/g;
const BUILTIN_AGENT_TOOL_NAMES = new Set([
	'describe_workspace',
	'list_skills',
	'read_skill',
	'read_collection',
	'write_collection',
	'spawn_subagent'
]);
/**
 * Derived from the shipped skills rather than listed, so the reserved set cannot fall behind what
 * `skills/` actually contains — a stale list would let a workspace compile a skill the runtime then
 * silently discards in favour of the host copy.
 */
const HOST_SKILL_NAMES: ReadonlySet<string> = new Set(HOST_SKILLS.map((skill) => skill.name));
const LAYOUT_PRIMITIVES = new Set([
	'Stack',
	'Inline',
	'Cluster',
	'Split',
	'Grid',
	'Columns',
	'Column',
	'Cover',
	'Center',
	'Frame',
	'Bound',
	'Scroll'
]);
const LAYOUT_GEOMETRY_PROPS = new Map<string, ReadonlySet<string>>([
	['Stack', new Set(['fill', 'grow', 'shrink'])],
	['Inline', new Set(['fill', 'grow', 'shrink'])],
	['Cluster', new Set(['fill', 'grow', 'shrink'])],
	['Bound', new Set(['grow', 'shrink'])],
	['Cover', new Set(['grow', 'shrink'])],
	['Scroll', new Set(['grow', 'shrink'])]
]);
const COMPONENT_TAG_PATTERN = /<([A-Z][\w.]*)\b([^>]*?)(?:\/?>)/gs;
const STATIC_CLASS_PATTERN = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const RAW_CLIP_CLASS_PATTERN = /\boverflow(?:-[xy])?-hidden\b/;
const RAW_SCROLL_CLASS_PATTERN = /\boverflow(?:-[xy])?-(?:auto|scroll|hidden|clip)\b/;
const RAW_SCROLL_SIZE_PATTERN = /\b(?:flex-1|min-h-0|h-full)\b/;
const RESERVED_IDENTIFIERS = new Set([
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'import',
	'in',
	'instanceof',
	'new',
	'null',
	'return',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield'
]);

function posixPath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeIdentifier(value: string): boolean {
	return /^[A-Za-z_$][\w$]*$/.test(value) && !RESERVED_IDENTIFIERS.has(value);
}

function relativePath(root: string, filePath: string): string {
	return posixPath(path.relative(root, filePath));
}

function topologyDiagnostic(file: string, code: string, message: string): StructuralDiagnostic {
	return {
		source: 'pod',
		severity: 'error',
		code,
		file,
		start: { line: 1, column: 1 },
		message
	};
}

/**
 * Attributes that carry identifiers, data keys, geometry, or URLs rather than
 * user-facing copy. Everything else that receives a quoted string literal with
 * copy-like content (an uppercase letter or whitespace) is a raw-copy error.
 */
const I18N_NON_COPY_ATTRIBUTES = new Set([
	'as',
	'class',
	'classname',
	'contentclass',
	'style',
	'name',
	'collection',
	'view',
	'icon',
	'href',
	'src',
	'id',
	'key',
	'type',
	'target',
	'rel',
	'role',
	'slot',
	'group',
	'variant',
	'size',
	'gap',
	'align',
	'justify',
	'measure',
	'side',
	'order',
	'inset',
	'shape',
	'orientation',
	'tabindex',
	'value',
	'alt',
	'data',
	'format',
	'dismissible',
	'strict',
	'loading',
	'frozen',
	'compact',
	'grow',
	'shrink',
	'fill',
	'reverse',
	'open',
	'active',
	'element',
	'action',
	'spellcheck',
	'autocomplete',
	'cols',
	'rows',
	'min',
	'max',
	'step',
	'multiline',
	'required',
	'disabled',
	'readonly',
	'default',
	'sortable',
	'pinned',
	'collapsed',
	'expandable',
	'muted',
	'color',
	'density',
	'part',
	'exportparts',
	'dir',
	'aria-hidden'
]);

/**
 * Values that look like identifiers, icons, URLs, or file paths — never copy.
 * Copy has an uppercase letter or whitespace, so anything matching this is exempt.
 */
const I18N_IDENTIFIER_VALUE_PATTERN = /^[a-z0-9_\-:.@/?&=%#~+*()]+$/;

const I18N_ATTRIBUTE_PATTERN = /\b([A-Za-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/**
 * A minimal, brace- and quote-aware scan of a Svelte source file. Emits text
 * nodes (content between tags) and component tags (attribute bodies) with
 * absolute offsets, so diagnostics can point at the offending string.
 */
type SvelteTag = { readonly start: number; readonly body: string };
type SvelteTextNode = { readonly start: number; readonly value: string };

function scanSvelteSource(source: string): { text: SvelteTextNode[]; tags: SvelteTag[] } {
	const text: SvelteTextNode[] = [];
	const tags: SvelteTag[] = [];
	let i = 0;
	while (i < source.length) {
		const open = source.indexOf('<', i);
		if (open < 0) break;
		if (open > i) text.push({ start: i, value: source.slice(i, open) });
		if (source.startsWith('<!--', open)) {
			const end = source.indexOf('-->', open + 4);
			i = end < 0 ? source.length : end + 3;
			continue;
		}
		if (source[open + 1] === '/') {
			const end = findTagEnd(source, open + 2);
			i = end < 0 ? source.length : end + 1;
			continue;
		}
		if (source[open + 1] === '!') {
			const end = source.indexOf('>', open);
			i = end < 0 ? source.length : end + 1;
			continue;
		}
		const end = findTagEnd(source, open + 1);
		if (end < 0) break;
		const body = source.slice(open + 1, end);
		if (/^[A-Z][\w.]*/.test(body)) {
			tags.push({ start: open + 1, body });
		}
		i = end + 1;
	}
	return { text, tags };
}

/**
 * Find the `>` that closes a tag started at `start`, skipping quoted attribute
 * values and `{...}` expressions (which may themselves contain `>` or quotes).
 */
function findTagEnd(source: string, start: number): number {
	let quote: '"' | "'" | null = null;
	let braceDepth = 0;
	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === '{') {
			braceDepth++;
			continue;
		}
		if (char === '}') {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (char === '>' && braceDepth === 0) return i;
	}
	return -1;
}

/**
 * The offset of the first user-facing letter or digit in a text node, ignoring
 * everything inside `{...}` expressions (balanced braces) and HTML entities
 * (`&nbsp;`, `&middot;`), or -1 when the text is empty, decorative-only, or
 * fully expression-driven.
 */
function firstRawTextOffset(value: string): number {
	let braceDepth = 0;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === '{') {
			braceDepth++;
			continue;
		}
		if (char === '}') {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (char === '&') {
			const entityEnd = value.indexOf(';', i);
			if (entityEnd >= 0) i = entityEnd;
			continue;
		}
		if (braceDepth === 0 && /[\p{L}\p{N}]/u.test(char)) return i;
	}
	return -1;
}

/**
 * The raw-copy guard: user-facing text in authored Svelte surfaces must come
 * from the tenant catalogs through `t(...)`. This is the static, analyzable
 * half of the i18n contract — a raw string is a missing catalog entry by
 * definition, so it is a structural error, not a style warning.
 */
function authoredI18nDiagnostics(source: string, file: string): StructuralDiagnostic[] {
	const diagnostics: StructuralDiagnostic[] = [];

	const ignoredRanges: Array<[number, number]> = [];
	for (const match of source.matchAll(
		/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<svelte:head\b[\s\S]*?<\/svelte:head>/gi
	)) {
		const start = match.index ?? 0;
		ignoredRanges.push([start, start + match[0].length]);
	}
	const inIgnored = (offset: number): boolean =>
		ignoredRanges.some(([start, end]) => offset >= start && offset < end);

	const { text, tags } = scanSvelteSource(source);

	for (const node of text) {
		if (inIgnored(node.start)) continue;
		const rawOffset = firstRawTextOffset(node.value);
		if (rawOffset < 0) continue;
		diagnostics.push(
			sourceDiagnostic(
				source,
				file,
				node.start + rawOffset,
				'I18N_RAW_TEXT',
				"User-facing text must come from t('key'); add the string to both catalogs"
			)
		);
	}

	for (const tag of tags) {
		const component = tag.body.match(/^[A-Z][\w.]*/)?.[0] ?? '';
		for (const attribute of tag.body.matchAll(I18N_ATTRIBUTE_PATTERN)) {
			const attributeName = attribute[1]!.toLowerCase();
			const rawValue = attribute[2] ?? '';
			const value = rawValue.slice(1, -1);
			const offset = tag.start + (attribute.index ?? 0);
			if (inIgnored(offset)) continue;
			if (I18N_NON_COPY_ATTRIBUTES.has(attributeName)) continue;
			if (!value.trim() || I18N_IDENTIFIER_VALUE_PATTERN.test(value)) continue;
			if (!/[A-Z]|\s/.test(value)) continue;
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					offset,
					'I18N_RAW_COPY_PROP',
					`${component} ${attribute[1]} expects a localized string; pass t('key') from both catalogs`
				)
			);
		}
	}

	return diagnostics;
}

/**
 * The tenant surface language deliberately has no escape hatch for host geometry.
 * This is a source guard, not a style linter. It validates the current layout contract:
 * named primitives own their geometry and authored surfaces cannot create implicit scroll chains.
 */
function authoredLayoutDiagnostics(
	source: string,
	file: string,
	options: { readonly checkPodLayout: boolean }
): StructuralDiagnostic[] {
	const diagnostics: StructuralDiagnostic[] = [];
	void options;
	for (const tag of source.matchAll(COMPONENT_TAG_PATTERN)) {
		const component = tag[1];
		const attributes = tag[2] ?? '';
		const attributesOffset = (tag.index ?? 0) + tag[0].indexOf(attributes);
		// Attribute names only: quoted values (text, class, icon names) must never be scanned
		// for prop names. Blanking quotes keeps every byte offset intact for diagnostics.
		const attributeNames = attributes.replace(/"[^"]*"|'[^']*'/g, (quoted) =>
			' '.repeat(quoted.length)
		);
		if (LAYOUT_PRIMITIVES.has(component)) {
			const styleAttribute = attributeNames.match(/\bstyle(?=\s*=|:)/);
			if (styleAttribute) {
				diagnostics.push(
					sourceDiagnostic(
						source,
						file,
						attributesOffset + (styleAttribute.index ?? 0),
						'LAYOUT_STYLE_RAW',
						`${component} does not accept inline style; use its named layout props`
					)
				);
			}
		}
		for (const attribute of attributeNames.matchAll(
			/\b(?:fill|grow|shrink|contentClass)(?=\s*=|\s|\/?>)/g
		)) {
			if (attribute[0] === 'contentClass' && component !== 'Tabs') continue;
			if (LAYOUT_GEOMETRY_PROPS.get(component)?.has(attribute[0])) continue;
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					attributesOffset + (attribute.index ?? 0),
					'LAYOUT_PROP_UNKNOWN',
					`${attribute[0]} is not a supported layout prop; parents own geometry`
				)
			);
		}
	}
	for (const match of source.matchAll(STATIC_CLASS_PATTERN)) {
		const classValue = match[1] ?? match[2] ?? '';
		const classOffset = (match.index ?? 0) + match[0].indexOf(classValue);
		if (RAW_CLIP_CLASS_PATTERN.test(classValue)) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					classOffset + (classValue.match(RAW_CLIP_CLASS_PATTERN)?.index ?? 0),
					'LAYOUT_CLIP_RAW',
					'Raw overflow-hidden is not allowed in authored surfaces; use Bound clip or Frame'
				)
			);
		}
		if (RAW_SCROLL_CLASS_PATTERN.test(classValue) && RAW_SCROLL_SIZE_PATTERN.test(classValue)) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					file,
					classOffset,
					'LAYOUT_SCROLL_CHAIN_RAW',
					'Raw flex/min-size/height scroll chains are not allowed; use an explicit Bound and Scroll pair'
				)
			);
		}
	}
	return diagnostics;
}

async function filesBelow(directory: string): Promise<string[]> {
	if (!existsSync(directory)) return [];
	const entries = await readdir(directory, { withFileTypes: true });
	const files = (
		await Promise.all(
			entries.map((entry): Promise<string[]> => {
				const entryPath = path.join(directory, entry.name);
				if (entry.isDirectory()) return filesBelow(entryPath);
				return Promise.resolve(entry.isFile() ? [entryPath] : []);
			})
		)
	).flat();
	return files.sort((left, right) => compareText(posixPath(left), posixPath(right)));
}

type SourceEntry = {
	readonly name: string;
	readonly kind: 'file' | 'directory';
	isFile(): boolean;
	isDirectory(): boolean;
};

class SourceInventory {
	readonly files: readonly string[];
	private readonly directories: ReadonlySet<string>;
	private readonly entriesByDirectory: ReadonlyMap<string, readonly SourceEntry[]>;
	private readonly sourceCache = new Map<string, Promise<string>>();

	private constructor(
		files: readonly string[],
		directories: ReadonlySet<string>,
		entriesByDirectory: ReadonlyMap<string, readonly SourceEntry[]>
	) {
		this.files = files;
		this.directories = directories;
		this.entriesByDirectory = entriesByDirectory;
	}

	static async load(sourceRoot: string): Promise<SourceInventory> {
		const files: string[] = [];
		const directories = new Set<string>();
		const entriesByDirectory = new Map<string, readonly SourceEntry[]>();

		const scan = async (directory: string): Promise<void> => {
			if (!existsSync(directory)) return;
			directories.add(directory);
			const diskEntries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
				compareText(left.name, right.name)
			);
			const entries = diskEntries.flatMap((entry): SourceEntry[] => {
				const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
				if (!kind) return [];
				return [
					{
						name: entry.name,
						kind,
						isFile: () => kind === 'file',
						isDirectory: () => kind === 'directory'
					}
				];
			});
			entriesByDirectory.set(directory, entries);
			await Promise.all(
				entries.map(async (entry) => {
					const entryPath = path.join(directory, entry.name);
					if (entry.kind === 'directory') await scan(entryPath);
					else files.push(entryPath);
				})
			);
		};

		await scan(sourceRoot);
		files.sort((left, right) => compareText(posixPath(left), posixPath(right)));
		return new SourceInventory(files, directories, entriesByDirectory);
	}

	hasDirectory(directory: string): boolean {
		return this.directories.has(directory);
	}

	hasFile(file: string): boolean {
		return this.files.includes(file);
	}

	entries(directory: string): readonly SourceEntry[] {
		return this.entriesByDirectory.get(directory) ?? [];
	}

	filesBelow(directory: string): readonly string[] {
		const prefix = `${directory}${path.sep}`;
		return this.files.filter((file) => file.startsWith(prefix));
	}

	source(file: string): Promise<string> {
		let cached = this.sourceCache.get(file);
		if (!cached) {
			cached = readFile(file, 'utf8');
			this.sourceCache.set(file, cached);
		}
		return cached;
	}
}

async function validateAuthoredSource(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<void> {
	await Promise.all(
		inventory.files.map(async (file) => {
			const authoredPath = relativePath(root, file);

			if (!file.endsWith('.ts') && !file.endsWith('.svelte')) return;
			const source = await inventory.source(file);
			for (const match of source.matchAll(PRIVATE_VIRTUAL_IMPORT_PATTERN)) {
				diagnostics.push(
					sourceDiagnostic(
						source,
						authoredPath,
						match.index ?? 0,
						'POD_VIRTUAL_IMPORT_PRIVATE',
						'virtual:pod/* modules are compiler-private; tenant source must use $pod/client'
					)
				);
			}
			if (file.endsWith('.svelte')) {
				diagnostics.push(
					...authoredLayoutDiagnostics(source, authoredPath, {
						checkPodLayout: !authoredPath.startsWith('src/apps/')
					}),
					...(authoredPath.startsWith('src/apps/')
						? authoredI18nDiagnostics(source, authoredPath)
						: [])
				);
			}
		})
	);
}

async function discoverCollections(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<{ relationships: string | null; collections: DiscoveredCollection[] }> {
	const directory = path.join(root, 'src/collections');
	const relationshipFile = path.join(directory, '+relationship.ts');
	if (!inventory.hasDirectory(directory)) {
		diagnostics.push(
			topologyDiagnostic(
				'src/collections',
				'COLLECTIONS_DIRECTORY_MISSING',
				'Required src/collections directory is missing'
			)
		);
		return { relationships: null, collections: [] };
	}

	const allFiles = inventory.filesBelow(directory);
	const relationshipFiles = allFiles.filter((file) => path.basename(file) === '+relationship.ts');
	if (!inventory.hasFile(relationshipFile)) {
		diagnostics.push(
			topologyDiagnostic(
				'src/collections/+relationship.ts',
				'RELATIONSHIP_MISSING',
				'Required collection relationship declaration is missing'
			)
		);
	}
	for (const file of relationshipFiles.filter((candidate) => candidate !== relationshipFile)) {
		diagnostics.push(
			topologyDiagnostic(
				relativePath(root, file),
				'RELATIONSHIP_DUPLICATE',
				'Relationships may only be declared in src/collections/+relationship.ts'
			)
		);
	}

	const entries = inventory.entries(directory);
	for (const entry of entries) {
		if (
			entry.isFile() &&
			entry.name.startsWith('+') &&
			entry.name !== '+relationship.ts' &&
			!entry.name.endsWith('.tool.ts')
		) {
			diagnostics.push(
				topologyDiagnostic(
					`src/collections/${entry.name}`,
					'COLLECTION_ROOT_ROLE_UNKNOWN',
					`Unknown collection-root role ${entry.name}`
				)
			);
		}
	}

	const discovered = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const collectionDirectory = path.join(directory, entry.name);
				const collectionPath = `src/collections/${entry.name}`;
				const model = path.join(collectionDirectory, '+model.ts');
				const collectionDiagnostics: StructuralDiagnostic[] = [];
				if (!inventory.hasFile(model)) {
					collectionDiagnostics.push(
						topologyDiagnostic(
							`${collectionPath}/+model.ts`,
							'COLLECTION_MODEL_MISSING',
							`Collection ${entry.name} requires +model.ts`
						)
					);
				}

				const localEntries = inventory.entries(collectionDirectory);
				const nestedFiles = inventory.filesBelow(collectionDirectory);
				for (const localEntry of localEntries) {
					if (
						localEntry.isFile() &&
						localEntry.name.startsWith('+') &&
						!localEntry.name.endsWith('.tool.ts') &&
						!COLLECTION_ROLE_FILES.some((role) => role === localEntry.name)
					) {
						collectionDiagnostics.push(
							topologyDiagnostic(
								`${collectionPath}/${localEntry.name}`,
								'COLLECTION_ROLE_UNKNOWN',
								`Unknown collection role ${localEntry.name}`
							)
						);
					}
				}

				for (const file of nestedFiles) {
					if (
						path.dirname(file) === collectionDirectory ||
						!path.basename(file).startsWith('+') ||
						path.basename(file).endsWith('.tool.ts')
					)
						continue;
					collectionDiagnostics.push(
						topologyDiagnostic(
							relativePath(root, file),
							'COLLECTION_NESTED',
							'Collection role files must be direct children of their collection directory'
						)
					);
				}

				const representationPath = path.join(collectionDirectory, '+representation.svelte');
				const representationBanner = inventory.hasFile(representationPath)
					? await extractStaticMetaValue(await inventory.source(representationPath), 'pod:banner')
					: null;
				const collection = inventory.hasFile(model)
					? ({
							id: entry.name,
							path: collectionPath,
							roles: {
								model: `${collectionPath}/+model.ts`,
								...(inventory.hasFile(path.join(collectionDirectory, '+hooks.ts'))
									? { hooks: `${collectionPath}/+hooks.ts` }
									: {}),
								...(inventory.hasFile(path.join(collectionDirectory, '+pipelines.ts'))
									? { pipelines: `${collectionPath}/+pipelines.ts` }
									: {}),
								...(inventory.hasFile(path.join(collectionDirectory, '+integrations.ts'))
									? { integrations: `${collectionPath}/+integrations.ts` }
									: {}),
								...(inventory.hasFile(representationPath)
									? { representation: `${collectionPath}/+representation.svelte` }
									: {})
							},
							...(representationBanner ? { representationBanner } : {})
						} satisfies DiscoveredCollection)
					: null;
				return { collectionDiagnostics, collection };
			})
	);
	for (const result of discovered) diagnostics.push(...result.collectionDiagnostics);
	const collections = discovered.flatMap(({ collection }) => (collection ? [collection] : []));

	return {
		relationships: inventory.hasFile(relationshipFile) ? 'src/collections/+relationship.ts' : null,
		collections
	};
}

async function discoverCustomTypes(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredCustomType[]> {
	const directory = path.join(root, 'src/custom-types');
	if (!inventory.hasDirectory(directory)) return [];
	const entries = inventory.entries(directory);
	const discovered = await Promise.all(
		entries.map(async (entry) => {
			const found: StructuralDiagnostic[] = [];
			const entryPath = `src/custom-types/${entry.name}`;
			if (!entry.isDirectory() || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(entry.name)) {
				found.push(
					topologyDiagnostic(
						entryPath,
						'CUSTOM_TYPE_DIRECTORY_INVALID',
						'src/custom-types must contain only lower_snake_case custom-type directories'
					)
				);
				return { found, customType: null };
			}
			const customTypeDirectory = path.join(directory, entry.name);
			const definition = path.join(customTypeDirectory, '+definition.ts');
			const renderer = path.join(customTypeDirectory, '+renderer.svelte');
			if (!inventory.hasFile(definition)) {
				found.push(
					topologyDiagnostic(
						`${entryPath}/+definition.ts`,
						'CUSTOM_TYPE_DEFINITION_MISSING',
						`Custom type ${entry.name} requires +definition.ts`
					)
				);
			}
			if (!inventory.hasFile(renderer)) {
				found.push(
					topologyDiagnostic(
						`${entryPath}/+renderer.svelte`,
						'CUSTOM_TYPE_RENDERER_MISSING',
						`Custom type ${entry.name} requires +renderer.svelte`
					)
				);
			}
			const customTypeFiles = inventory.filesBelow(customTypeDirectory);
			const definitionSource = inventory.hasFile(definition)
				? await inventory.source(definition)
				: null;
			for (const file of customTypeFiles) {
				const relative = relativePath(root, file);
				const direct = path.dirname(file) === customTypeDirectory;
				const role = path.basename(file);
				if (!direct) {
					found.push(
						topologyDiagnostic(
							relative,
							'CUSTOM_TYPE_NESTED',
							'Custom-type role files must be direct children of their custom-type directory'
						)
					);
					continue;
				}
				if (
					role !== '+definition.ts' &&
					role !== '+renderer.svelte' &&
					!role.endsWith('.tool.ts')
				) {
					found.push(
						topologyDiagnostic(
							relative,
							'CUSTOM_TYPE_ROLE_UNKNOWN',
							`Unknown custom-type role ${role}`
						)
					);
				}
			}
			if (definitionSource !== null) {
				const source = definitionSource;
				for (const imported of source.matchAll(
					/\b(?:import|export)\s+[^;]*?\sfrom\s*(['"])([^'"]+)\1/g
				)) {
					const specifier = imported[2];
					if (!specifier.split('/').includes('collections')) continue;
					found.push(
						sourceDiagnostic(
							source,
							`${entryPath}/+definition.ts`,
							imported.index ?? 0,
							'CUSTOM_TYPE_DEFINITION_OWNERSHIP_INVERTED',
							'Custom-type schemas belong in +definition.ts; collection modules may consume them, but definitions cannot import from collections'
						)
					);
				}
				const declared = source.match(
					/export\s+default\s+defineCustomType\s*\(\s*\{[\s\S]*?\bname\s*:\s*(['"])([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\1/
				);
				if (!declared) {
					found.push(
						topologyDiagnostic(
							`${entryPath}/+definition.ts`,
							'CUSTOM_TYPE_DEFINITION_INVALID',
							'Custom-type definitions must default-export defineCustomType({ name, description, schema })'
						)
					);
				} else if (declared[2] !== entry.name) {
					found.push(
						topologyDiagnostic(
							`${entryPath}/+definition.ts`,
							'CUSTOM_TYPE_NAME_MISMATCH',
							`Custom type name ${declared[2]} must match directory ${entry.name}`
						)
					);
				}
			}
			const customType =
				inventory.hasFile(definition) && inventory.hasFile(renderer)
					? ({
							id: entry.name,
							path: entryPath,
							definition: `${entryPath}/+definition.ts`,
							renderer: `${entryPath}/+renderer.svelte`
						} satisfies DiscoveredCustomType)
					: null;
			return { found, customType };
		})
	);
	for (const result of discovered) diagnostics.push(...result.found);
	const customTypes = discovered.flatMap(({ customType }) => (customType ? [customType] : []));
	return customTypes;
}

async function discoverAppDirectory(
	appsRoot: string,
	directory: string,
	parentId: string | null,
	nodes: DiscoveredAppNode[],
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory,
	isRoot = false
): Promise<void> {
	const relativeDirectory = posixPath(path.relative(appsRoot, directory));
	const id = relativeDirectory || null;
	const sourcePath = id ? `src/apps/${id}` : 'src/apps';
	const groupFile = path.join(directory, '+group.ts');
	const hasGroup = inventory.hasFile(groupFile);
	const entries = inventory.entries(directory);

	if (!isRoot) {
		if (!hasGroup) {
			diagnostics.push(
				topologyDiagnostic(
					sourcePath,
					'APP_GROUP_ROLE_MISSING',
					'Every directory under src/apps must be a group with +group.ts'
				)
			);
		} else {
			nodes.push({
				id: relativeDirectory,
				kind: 'group',
				path: sourcePath,
				parentId,
				source: `${sourcePath}/+group.ts`
			});
		}
	}

	const appParentId = !isRoot && hasGroup ? id : parentId;
	// stupidity:allow A6 -- app diagnostics are emitted in sorted source order.
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name === '+group.ts' && !isRoot) continue;
		if (entry.name.endsWith('.tool.ts')) continue;
		const source = `${sourcePath}/${entry.name}`;
		if (
			entry.name === '+app.svelte' ||
			!/^\+[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.svelte$/.test(entry.name)
		) {
			if (entry.name.startsWith('+') || entry.name.endsWith('.svelte')) {
				diagnostics.push(
					topologyDiagnostic(
						source,
						'APP_ROLE_INVALID',
						'src/apps must contain only +<lower_snake_case>.svelte app files and +group.ts group metadata'
					)
				);
			}
			continue;
		}
		const leafId = entry.name.slice(1, -'.svelte'.length);
		const appId = id ? `${id}/${leafId}` : leafId;
		const appSource = await inventory.source(path.join(directory, entry.name));
		const result = extractAppMetadata(appSource, source);
		diagnostics.push(...result.diagnostics);
		if (result.metadata) {
			nodes.push({
				id: appId,
				kind: 'app',
				path: `src/apps/${appId}`,
				parentId: appParentId,
				source,
				metadata: result.metadata
			});
		}
	}

	// stupidity:allow A6 -- recursive app discovery preserves deterministic tree order.
	for (const child of entries.filter((entry) => entry.isDirectory())) {
		await discoverAppDirectory(
			appsRoot,
			path.join(directory, child.name),
			appParentId,
			nodes,
			diagnostics,
			inventory
		);
	}
}

async function discoverApps(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredAppNode[]> {
	const appsRoot = path.join(root, 'src/apps');
	if (!inventory.hasDirectory(appsRoot)) {
		diagnostics.push(
			topologyDiagnostic(
				'src/apps',
				'APPS_DIRECTORY_MISSING',
				'Required src/apps directory is missing'
			)
		);
		return [];
	}

	const nodes: DiscoveredAppNode[] = [];
	await discoverAppDirectory(appsRoot, appsRoot, null, nodes, diagnostics, inventory, true);
	if (!nodes.some((node) => node.kind === 'app')) {
		diagnostics.push(
			topologyDiagnostic('src/apps', 'APP_MISSING', 'Workspace requires at least one app')
		);
	}
	return nodes.sort((left, right) => compareText(left.id, right.id));
}

async function discoverWorkspaceRoles(
	root: string,
	directoryName: 'automation' | 'remotes',
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredWorkspaceRole[]> {
	const directory = path.join(root, 'src', directoryName);
	if (!inventory.hasDirectory(directory)) return [];
	const isAutomation = directoryName === 'automation';
	const singular = isAutomation ? 'AUTOMATION' : 'REMOTE';
	const roles: DiscoveredWorkspaceRole[] = [];
	for (const entry of inventory.entries(directory)) {
		const source = `src/${directoryName}/${entry.name}`;
		if (entry.isFile() && entry.name.endsWith('.tool.ts')) continue;
		if (!entry.isFile() || !/^\+[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.ts$/.test(entry.name)) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					`${singular}_ROLE_INVALID`,
					isAutomation
						? 'src/automation must contain only flat +<lower_snake_case>.ts declaration files'
						: 'src/remotes must contain only flat +<lower_snake_case>.ts declaration files'
				)
			);
			continue;
		}
		const id = entry.name.slice(1, -3);
		roles.push({ id, path: `src/${directoryName}/${id}`, source });
	}
	return roles;
}

/**
 * Directories under `src/` whose `+<name>.ts` files mean something.
 *
 * `lib` is free-form helper code, `skills` is documentation whose attachments may well be example
 * `+model.ts` snippets, and `collections`/`apps` nest, so they are listed to be skipped rather than
 * scanned.
 */
const KNOWN_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set([
	'apps',
	'automation',
	'channels',
	'collections',
	'custom-types',
	'lib',
	'policies',
	'remotes',
	'skills'
]);

/**
 * Refuse a role declaration sitting in a directory nothing reads.
 *
 * Discovery is a whitelist: only `src/automation` and `src/remotes` are scanned for `+<name>.ts`. A
 * file in `src/automations` — the plural, which the mixed singular/plural convention invites — was
 * simply never registered, so the automation never ran and nothing said why. A bad role file *inside*
 * a known directory was always a hard error; only the directory name escaped checking.
 *
 * Agent tools are exempt: `+<name>.tool.ts` is deliberately discoverable anywhere under `src`.
 */
function validateRoleDirectories(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): void {
	const sourceRoot = path.join(root, 'src');
	if (!inventory.hasDirectory(sourceRoot)) return;
	for (const entry of inventory.entries(sourceRoot)) {
		if (!entry.isDirectory() || KNOWN_SOURCE_DIRECTORIES.has(entry.name)) continue;
		const directory = path.join(sourceRoot, entry.name);
		const orphans = [directory, ...inventory.filesBelow(directory)].filter(
			(file) => path.basename(file).startsWith('+') && !file.endsWith('.tool.ts')
		);
		if (orphans.length === 0) continue;
		const nearest = nearestName(entry.name, KNOWN_SOURCE_DIRECTORIES);
		const suggestion = nearest ? ` Did you mean src/${nearest}?` : '';
		diagnostics.push(
			topologyDiagnostic(
				relativePath(root, orphans[0] ?? directory),
				'WORKSPACE_ROLE_ORPHANED',
				`src/${entry.name} is not a role directory, so its +<name>.ts declarations are never registered.${suggestion}`
			)
		);
	}
}

async function discoverAgentTools(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredWorkspaceRole[]> {
	const sourceRoot = path.join(root, 'src');
	if (!inventory.hasDirectory(sourceRoot)) return [];
	const tools: DiscoveredWorkspaceRole[] = [];
	const seen = new Map<string, string>();
	for (const file of inventory.files) {
		const name = path.basename(file);
		const match = name.match(/^\+([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.tool\.ts$/);
		if (!match) continue;
		const id = match[1]!;
		const source = relativePath(root, file);
		if (BUILTIN_AGENT_TOOL_NAMES.has(id)) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'AGENT_TOOL_NAME_RESERVED',
					`Agent tool ${id} is reserved by the Pod runtime`
				)
			);
			continue;
		}
		const previous = seen.get(id);
		if (previous) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'AGENT_TOOL_DUPLICATE',
					`Agent tool ${id} is already declared by ${previous}`
				)
			);
			continue;
		}
		seen.set(id, source);
		tools.push({ id, path: source.slice(0, -3), source });
	}
	return tools.sort((left, right) => compareText(left.id, right.id));
}

/**
 * Policies declared in `src/policies/+<name>.policy.ts`.
 *
 * Confined to one directory, unlike agent tools: a policy is workspace-wide permission surface, and
 * letting one hide next to a collection would make the total set of grants something you have to
 * search for rather than read.
 */
async function discoverPolicies(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredWorkspaceRole[]> {
	const directory = path.join(root, 'src', 'policies');
	if (!inventory.hasDirectory(directory)) return [];
	const policies: DiscoveredWorkspaceRole[] = [];
	const seen = new Map<string, string>();
	for (const entry of inventory.entries(directory)) {
		const source = relativePath(root, path.join(directory, entry.name));
		if (entry.isDirectory()) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'POLICY_UNEXPECTED_DIRECTORY',
					'src/policies contains only +<name>.policy.ts files'
				)
			);
			continue;
		}
		const match = entry.name.match(/^\+([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.policy\.ts$/);
		if (!match) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'POLICY_NAME_INVALID',
					`${entry.name} must be named +<lower_snake_case>.policy.ts`
				)
			);
			continue;
		}
		const id = match[1]!;
		const previous = seen.get(id);
		if (previous) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'POLICY_DUPLICATE',
					`Policy ${id} is already declared by ${previous}`
				)
			);
			continue;
		}
		seen.set(id, source);
		policies.push({ id, path: source.slice(0, -3), source });
	}
	return policies.sort((left, right) => compareText(left.id, right.id));
}

/**
 * `src/channels/+<name>.channel.ts` — one conversational entry point per file.
 *
 * Same shape as policy discovery: the filename is the identity, so there is no registry to keep in
 * step and a misnamed file is an error rather than a declaration that silently does nothing.
 */
async function discoverChannels(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredWorkspaceRole[]> {
	const directory = path.join(root, 'src', 'channels');
	if (!inventory.hasDirectory(directory)) return [];
	const channels: DiscoveredWorkspaceRole[] = [];
	const seen = new Map<string, string>();
	for (const entry of inventory.entries(directory)) {
		const source = relativePath(root, path.join(directory, entry.name));
		if (entry.isDirectory()) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'CHANNEL_UNEXPECTED_DIRECTORY',
					'src/channels contains only +<name>.channel.ts files'
				)
			);
			continue;
		}
		const match = entry.name.match(/^\+([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.channel\.ts$/);
		if (!match) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'CHANNEL_NAME_INVALID',
					`${entry.name} must be named +<lower_snake_case>.channel.ts`
				)
			);
			continue;
		}
		const id = match[1]!;
		const previous = seen.get(id);
		if (previous) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'CHANNEL_DUPLICATE',
					`Channel ${id} is already declared by ${previous}`
				)
			);
			continue;
		}
		seen.set(id, source);
		channels.push({ id, path: source.slice(0, -3), source });
	}
	return channels.sort((left, right) => compareText(left.id, right.id));
}

/**
 * The directory each file belongs to, once nested skills are possible.
 *
 * `src/skills/a/b/SKILL.md` makes `b` a skill in its own right, so `b`'s contents must not also be
 * loaded as reference material for `a`: an agent reading `a` would otherwise see a second skill's
 * instructions presented as part of the first.
 */
function nearestSkillRoot(file: string, roots: readonly string[]): string | undefined {
	return roots
		.filter((root) => file.startsWith(`${root}${path.sep}`))
		.sort((left, right) => right.length - left.length)[0];
}

/**
 * Skills authored under `src/skills/`, discovered by their `SKILL.md` at any depth.
 *
 * Depth is unrestricted for the same reason agent tools are: a `SKILL.md` the compiler skipped
 * because it sat one directory too deep would be a skill its author believes they shipped and the
 * agent never sees. Every one found either registers under the name of the directory holding it or
 * says why it could not.
 */
async function discoverSkills(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredSkill[]> {
	const skillsRoot = path.join(root, 'src', 'skills');
	if (!inventory.hasDirectory(skillsRoot)) return [];
	const manifests = inventory
		.filesBelow(skillsRoot)
		.filter((file) => path.basename(file) === 'SKILL.md');
	const roots = manifests.map((file) => path.dirname(file));
	const skills: DiscoveredSkill[] = [];
	const seen = new Map<string, string>();
	for (const manifest of manifests) {
		const directory = path.dirname(manifest);
		const name = path.basename(directory);
		const source = relativePath(root, manifest);
		if (!isValidSkillName(name)) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'SKILL_NAME_INVALID',
					`Skill directory ${name} must be lowercase hyphenated and at most 64 characters`
				)
			);
			continue;
		}
		if (HOST_SKILL_NAMES.has(name)) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'SKILL_NAME_RESERVED',
					`Skill ${name} is shipped by Pod, and the host skill wins the name, so this one would never be read`
				)
			);
			continue;
		}
		const previous = seen.get(name);
		if (previous) {
			diagnostics.push(
				topologyDiagnostic(
					source,
					'SKILL_DUPLICATE',
					`Skill ${name} is already declared by ${previous}`
				)
			);
			continue;
		}
		const parsed = parseSkillDocument(await inventory.source(manifest), name);
		if (!parsed.ok) {
			diagnostics.push(topologyDiagnostic(source, parsed.code, parsed.message));
			continue;
		}
		const files = await Promise.all(
			inventory
				.filesBelow(directory)
				.filter((file) => file !== manifest && nearestSkillRoot(file, roots) === directory)
				.map(async (file) => ({
					path: posixPath(path.relative(directory, file)),
					text: await inventory.source(file)
				}))
		);
		seen.set(name, source);
		skills.push({ ...parsed.document, source, files });
	}
	return skills.sort((left, right) => compareText(left.name, right.name));
}

/** Flat `src/+<name>.ts` declarations the compiler reads. Anything else there is a mistake. */
const WORKSPACE_ROOT_DECLARATIONS: ReadonlySet<string> = new Set([
	'+agent.ts',
	'+seed.ts',
	'+env.ts'
]);

/**
 * Tenant translation overrides: `src/i18n/messages.<locale>.json`, one file per
 * entry in the platform's `SUPPORTED_LOCALES` list.
 *
 * Every supported locale must carry exactly the same key set — a catalog
 * missing a primary-locale key (or carrying a stray one) is an authoring
 * error, not a fallback decision; the runtime fallback exists for languages,
 * not for this locale pair. Anything else in `src/i18n/` is rejected like an
 * unknown root role. Adding a language is a one-line change in
 * `@norbital-ai/std/i18n` (`SUPPORTED_LOCALES`); the tenant contract follows
 * automatically.
 */
const I18N_MESSAGE_FILES: ReadonlySet<string> = new Set(
	SUPPORTED_LOCALES.map((locale) => `messages.${locale}.json`)
);

async function discoverI18n(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<DiscoveredI18n> {
	const i18nDirectory = path.join(root, 'src', 'i18n');
	const hasAppSurfaces = inventory
		.filesBelow(path.join(root, 'src', 'apps'))
		.some((file) => file.endsWith('.svelte'));
	if (!inventory.hasDirectory(i18nDirectory)) {
		if (hasAppSurfaces) {
			diagnostics.push(
				topologyDiagnostic(
					`src/i18n/messages.${DEFAULT_LOCALE}.json`,
					'I18N_CATALOG_MISSING',
					`Workspaces with apps ship src/i18n/messages.<locale>.json for every supported locale (${SUPPORTED_LOCALES.join(', ')}), with exact same keys. Wire i18n even when the workspace ships one language — mirror the copy in the other locales.`
				)
			);
		}
		return { present: false, catalogs: {}, primary: DEFAULT_LOCALE, en: null, zh: null };
	}
	for (const entry of inventory.entries(i18nDirectory)) {
		if (entry.isFile() && !I18N_MESSAGE_FILES.has(entry.name)) {
			const file = posixPath(path.join('src', 'i18n', entry.name));
			diagnostics.push(
				topologyDiagnostic(
					file,
					'I18N_FILE_UNKNOWN',
					`Unknown i18n file ${entry.name}. Only messages.<locale>.json for the supported locales (${SUPPORTED_LOCALES.join(', ')}) are allowed.`
				)
			);
		}
	}

	async function readLocale(locale: string): Promise<Readonly<Record<string, string>> | null> {
		const fileName = `messages.${locale}.json`;
		const file = path.join(i18nDirectory, fileName);
		if (!inventory.hasFile(file)) return null;
		const source = await inventory.source(file);
		const parsed = safeParse(source);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					posixPath(path.join('src', 'i18n', fileName)),
					0,
					'I18N_CATALOG_INVALID',
					`${fileName} must be a JSON object mapping message keys to strings`
				)
			);
			return null;
		}
		const messages: Record<string, string> = {};
		let invalidOffset: number | null = null;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string') {
				messages[key] = value;
				continue;
			}
			if (invalidOffset === null) {
				invalidOffset = source.indexOf(key);
			}
		}
		if (invalidOffset !== null) {
			diagnostics.push(
				sourceDiagnostic(
					source,
					posixPath(path.join('src', 'i18n', fileName)),
					Math.max(0, invalidOffset),
					'I18N_CATALOG_INVALID',
					`${fileName} values must all be strings`
				)
			);
			return null;
		}
		return messages;
	}

	const catalogs = Object.fromEntries(
		await Promise.all(
			SUPPORTED_LOCALES.map(async (locale) => [locale, await readLocale(locale)] as const)
		)
	);

	const primary = catalogs[DEFAULT_LOCALE] ?? null;
	for (const locale of SUPPORTED_LOCALES) {
		const catalog = catalogs[locale] ?? null;
		const fileName = `messages.${locale}.json`;
		if (catalog) continue;
		if (hasAppSurfaces || locale !== DEFAULT_LOCALE) {
			diagnostics.push(
				topologyDiagnostic(
					`src/i18n/${fileName}`,
					'I18N_CATALOG_MISSING',
					`src/i18n/${fileName} is missing. Every supported locale (${SUPPORTED_LOCALES.join(', ')}) ships a catalog with the same keys; mirror the ${DEFAULT_LOCALE} copy when a translation is not ready.`
				)
			);
		}
	}

	if (primary) {
		for (const locale of SUPPORTED_LOCALES) {
			const catalog = catalogs[locale];
			if (!catalog) continue;
			const fileName = `messages.${locale}.json`;
			for (const key of Object.keys(primary)) {
				if (!(key in catalog)) {
					diagnostics.push(
						topologyDiagnostic(
							`src/i18n/${fileName}`,
							'I18N_CATALOG_MISSING_KEY',
							`${fileName} is missing key "${key}" present in messages.${DEFAULT_LOCALE}.json`
						)
					);
				}
			}
			for (const key of Object.keys(catalog)) {
				if (!(key in primary)) {
					diagnostics.push(
						topologyDiagnostic(
							`src/i18n/${fileName}`,
							'I18N_CATALOG_EXTRA_KEY',
							`${fileName} has key "${key}" not present in messages.${DEFAULT_LOCALE}.json`
						)
					);
				}
			}
		}
	}

	return {
		present: true,
		catalogs,
		primary: DEFAULT_LOCALE,
		en: catalogs.en ?? null,
		zh: catalogs.zh ?? null
	};
}

async function discoverSeed(
	root: string,
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<{
	readonly agent: string | null;
	readonly seed: string | null;
	readonly env: string | null;
}> {
	const sourceDirectory = path.join(root, 'src');
	if (!inventory.hasDirectory(sourceDirectory)) return { agent: null, seed: null, env: null };
	for (const entry of inventory.entries(sourceDirectory)) {
		if (
			entry.isFile() &&
			entry.name.startsWith('+') &&
			entry.name.endsWith('.ts') &&
			!WORKSPACE_ROOT_DECLARATIONS.has(entry.name) &&
			!entry.name.endsWith('.tool.ts')
		) {
			// Facilities are the host's contract, not a tenant role. The generic "unknown role" message
			// reads like a typo, so name the reason: there is nowhere for a workspace to declare one.
			const isFacilityAttempt = /^\+facilit(y|ies)\.ts$/.test(entry.name);
			diagnostics.push(
				topologyDiagnostic(
					`src/${entry.name}`,
					isFacilityAttempt ? 'WORKSPACE_ROLE_RESERVED' : 'WORKSPACE_ROLE_UNKNOWN',
					isFacilityAttempt
						? `Facilities are supplied by the active host, not declared by a workspace. Remove src/${entry.name} and configure the facility in pod.host.ts.`
						: `Unknown workspace role ${entry.name}`
				)
			);
		}
	}
	return {
		agent: inventory.hasFile(path.join(sourceDirectory, '+agent.ts')) ? 'src/+agent.ts' : null,
		seed: inventory.hasFile(path.join(sourceDirectory, '+seed.ts')) ? 'src/+seed.ts' : null,
		env: inventory.hasFile(path.join(sourceDirectory, '+env.ts')) ? 'src/+env.ts' : null
	};
}

async function validateCustomTypeReferences(
	root: string,
	collections: readonly DiscoveredCollection[],
	customTypes: readonly DiscoveredCustomType[],
	diagnostics: StructuralDiagnostic[],
	inventory: SourceInventory
): Promise<void> {
	const known = new Set(customTypes.map((customType) => customType.id));
	const collectionDiagnostics = await Promise.all(
		collections.map(async (collection) => {
			const found: StructuralDiagnostic[] = [];
			const source = await inventory.source(path.join(root, collection.roles.model));
			for (const call of source.matchAll(/\bcustom\s*\(\s*/g)) {
				const argumentStart = (call.index ?? 0) + call[0].length;
				const match = source.slice(argumentStart).match(/^(['"])([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\1/);
				if (!match) {
					found.push(
						sourceDiagnostic(
							source,
							collection.roles.model,
							call.index ?? 0,
							'CUSTOM_TYPE_REFERENCE_INVALID',
							'custom() requires a static filesystem custom-type name'
						)
					);
					continue;
				}
				const kind = match[2];
				if (known.has(kind)) continue;
				found.push(
					sourceDiagnostic(
						source,
						collection.roles.model,
						argumentStart + match[0].indexOf(kind),
						'CUSTOM_TYPE_UNKNOWN',
						`Custom type ${kind} has no src/custom-types/${kind}/+definition.ts`
					)
				);
			}
			return found;
		})
	);
	for (const found of collectionDiagnostics) diagnostics.push(...found);
}

export async function discoverPodFilesystem(root: string): Promise<PodStructure> {
	const absoluteRoot = path.resolve(root);
	const diagnostics: StructuralDiagnostic[] = [];
	const inventory = await SourceInventory.load(path.join(absoluteRoot, 'src'));
	const [collections, customTypes] = await Promise.all([
		discoverCollections(absoluteRoot, diagnostics, inventory),
		discoverCustomTypes(absoluteRoot, diagnostics, inventory)
	]);
	await validateCustomTypeReferences(
		absoluteRoot,
		collections.collections,
		customTypes,
		diagnostics,
		inventory
	);
	const [apps, automations, remotes, agentTools, policies, channels, skills, rootDeclarations] =
		await Promise.all([
			discoverApps(absoluteRoot, diagnostics, inventory),
			discoverWorkspaceRoles(absoluteRoot, 'automation', diagnostics, inventory),
			discoverWorkspaceRoles(absoluteRoot, 'remotes', diagnostics, inventory),
			discoverAgentTools(absoluteRoot, diagnostics, inventory),
			discoverPolicies(absoluteRoot, diagnostics, inventory),
			discoverChannels(absoluteRoot, diagnostics, inventory),
			discoverSkills(absoluteRoot, diagnostics, inventory),
			discoverSeed(absoluteRoot, diagnostics, inventory),
			validateAuthoredSource(absoluteRoot, diagnostics, inventory)
		]);
	const i18n = await discoverI18n(absoluteRoot, diagnostics, inventory);
	validateRoleDirectories(absoluteRoot, diagnostics, inventory);
	diagnostics.sort(
		(left, right) =>
			compareText(left.file, right.file) ||
			left.start.line - right.start.line ||
			left.start.column - right.start.column ||
			compareText(left.code, right.code)
	);
	return {
		version: 1,
		relationships: collections.relationships,
		collections: collections.collections,
		customTypes,
		apps,
		automations,
		remotes,
		agentTools,
		policies,
		channels,
		skills,
		i18n,
		agent: rootDeclarations.agent,
		seed: rootDeclarations.seed,
		env: rootDeclarations.env,
		diagnostics
	};
}

function generatedImport(sourcePath: string): string {
	const specifier = `../../${sourcePath}`.replace(/\.ts$/, '.js');
	return specifier;
}

function renderModels(collections: readonly DiscoveredCollection[]): string {
	const imports = collections
		.map(
			(collection, index) =>
				`import model${index} from ${JSON.stringify(generatedImport(collection.roles.model))};`
		)
		.join('\n');
	const models = collections
		.map((collection, index) => `\t${JSON.stringify(collection.id)}: model${index}`)
		.join(',\n');
	return `import { defineModels } from '@norbital-ai/pod/authoring/internals';\n${imports}\n\nexport const models = defineModels({\n${models}\n});\n\nexport type Models = typeof models;\n`;
}

function renderRegistry(collections: readonly DiscoveredCollection[]): string {
	const usedNames = new Set<string>();
	const tableExports = collections.map((collection, index) => {
		let exportName = isSafeIdentifier(collection.id) ? collection.id : `_collection_${index}`;
		while (usedNames.has(exportName)) exportName = `_${exportName}`;
		usedNames.add(exportName);
		return `export const ${exportName} = registry.tables[${JSON.stringify(collection.id)}];`;
	});
	return `import { defineRuntimeRegistry, platformIdentityTables } from '@norbital-ai/pod/authoring/internals';\nimport relationships from '../../src/collections/+relationship.js';\nimport { customTypes } from './custom-types.js';\nimport { models } from './models.js';\n\nexport const registry = defineRuntimeRegistry({ models, relationships, customTypes, platformTables: platformIdentityTables });\n\n${tableExports.join('\n')}\n\nexport type Registry = typeof registry;\n`;
}

function renderApps(nodes: readonly DiscoveredAppNode[]): string {
	const groups = nodes.filter((node) => node.kind === 'group');
	const groupImports = groups
		.map(
			(group, index) =>
				`import group${index} from ${JSON.stringify(generatedImport(group.source))};`
		)
		.join('\n');
	const imports = groups.length
		? `import type { GroupDefinition, WorkspaceAppDef } from '@norbital-ai/pod/authoring/internals';\n${groupImports}`
		: `import type { WorkspaceAppDef } from '@norbital-ai/pod/authoring/internals';`;
	const declarations = groups
		.map((_, index) => `const group${index}Metadata: GroupDefinition = group${index};`)
		.join('\n');
	const groupIndexes = new Map(groups.map((group, index) => [group.id, index]));

	function renderWorkspaceApps(parentId: string | null, depth: number): string {
		const children = nodes.filter((node) => node.parentId === parentId);
		const indentation = '\t'.repeat(depth);
		return children
			.map((node) => {
				const key = node.id.split('/').at(-1) ?? node.id;
				if (node.kind === 'app') {
					return `${indentation}${JSON.stringify(key)}: {\n${indentation}\tname: ${JSON.stringify(node.metadata.title)},\n${indentation}\tdescription: ${JSON.stringify(node.metadata.description)},\n${indentation}\ticon: ${JSON.stringify(node.metadata.icon)},\n${indentation}\tthumbnail: ${JSON.stringify(node.metadata.thumbnail)},\n${indentation}\tbanner: ${JSON.stringify(node.metadata.banner)}\n${indentation}}`;
				}
				const index = groupIndexes.get(node.id);
				return `${indentation}${JSON.stringify(key)}: {\n${indentation}\tname: group${index}Metadata.label,\n${indentation}\tdescription: group${index}Metadata.description,\n${indentation}\ticon: group${index}Metadata.icon,\n${indentation}\tdefaultChild: group${index}Metadata.defaultChild,\n${indentation}\tcomponent: {\n${renderWorkspaceApps(node.id, depth + 2)}\n${indentation}\t}\n${indentation}}`;
			})
			.join(',\n');
	}

	return `${imports}\n\n${declarations}${declarations ? '\n\n' : ''}export const apps = {\n${renderWorkspaceApps(null, 1)}\n} as const satisfies Record<string, WorkspaceAppDef>;\n\nexport type Apps = typeof apps;\n`;
}

function renderCollectionSurfaces(collections: readonly DiscoveredCollection[]): string {
	const imports: string[] = [];
	const entries: string[] = [];
	for (const [index, collection] of collections.entries()) {
		const properties: string[] = [];
		if (collection.roles.representation) {
			imports.push(
				`import representation${index} from ${JSON.stringify(generatedImport(collection.roles.representation))};`
			);
			properties.push(`representation: representation${index}`);
		}
		if (collection.representationBanner) {
			properties.push(`banner: ${JSON.stringify(collection.representationBanner)}`);
		}
		if (properties.length > 0) {
			entries.push(`\t${JSON.stringify(collection.id)}: { ${properties.join(', ')} }`);
		}
	}
	return `${imports.join('\n')}\n\nexport const collectionSurfaces = Object.freeze({\n${entries.join(',\n')}\n});\n`;
}

function renderCustomTypeRenderers(customTypes: readonly DiscoveredCustomType[]): string {
	const imports = customTypes.map((customType, index) => {
		return `import renderer${index} from ${JSON.stringify(generatedImport(customType.renderer))};`;
	});
	const entries = customTypes.map(
		(customType, index) => `\t${JSON.stringify(customType.id)}: renderer${index}`
	);
	return `${imports.join('\n')}\n\nexport const customTypeRenderers = Object.freeze({\n${entries.join(',\n')}\n});\n`;
}

function renderCustomTypes(customTypes: readonly DiscoveredCustomType[]): string {
	const imports = customTypes.map(
		(customType, index) =>
			`import definition${index} from ${JSON.stringify(generatedImport(customType.definition))};`
	);
	const entries = customTypes.map(
		(customType, index) => `\t${JSON.stringify(customType.id)}: definition${index}`
	);
	return `import type { CustomTypeOutput } from '@norbital-ai/pod/authoring';\n${imports.join('\n')}\n\nexport const customTypes = {\n${entries.join(',\n')}\n} as const;\n\nexport type CustomKind = keyof typeof customTypes;\nexport type CustomValue<K extends CustomKind> = CustomTypeOutput<(typeof customTypes)[K]>;\n`;
}

function renderCustomTypeValueMap(customTypes: readonly DiscoveredCustomType[]): string {
	const imports = customTypes.map(
		(customType, index) =>
			`import type definition${index} from ${JSON.stringify(generatedImport(customType.definition))};`
	);
	const valueEntries = customTypes.map(
		(customType, index) =>
			`\t\treadonly ${JSON.stringify(customType.id)}: CustomTypeOutput<typeof definition${index}>;`
	);
	const optionsEntries = customTypes.map(
		(customType, index) =>
			`\t\treadonly ${JSON.stringify(customType.id)}: CustomTypeFactoryOptions<typeof definition${index}>;`
	);
	return `import type { CustomTypeFactoryOptions, CustomTypeOutput } from '@norbital-ai/pod/authoring';\n${imports.join('\n')}\n\ndeclare module '@norbital-ai/pod/authoring' {\n\tinterface CustomTypeValueMap {\n${valueEntries.join('\n')}\n\t}\n\tinterface CustomTypeOptionsMap {\n${optionsEntries.join('\n')}\n\t}\n}\n\nexport {};\n`;
}

/**
 * A skill written out as a literal, because there is no module to import one from.
 *
 * `JSON.stringify` on every string is load-bearing rather than tidy: the values are markdown, which
 * routinely contains backticks, `${`, and backslashes, so any other quoting would let a skill's own
 * prose terminate the string it is being emitted into and break the generated module.
 */
function renderSkill(skill: DiscoveredSkill): string {
	const fields = [
		`\t\t\tname: ${JSON.stringify(skill.name)}`,
		`\t\t\tdescription: ${JSON.stringify(skill.description)}`
	];
	if (skill.license) fields.push(`\t\t\tlicense: ${JSON.stringify(skill.license)}`);
	if (skill.compatibility) {
		fields.push(`\t\t\tcompatibility: ${JSON.stringify(skill.compatibility)}`);
	}
	if (skill.metadata) fields.push(`\t\t\tmetadata: ${JSON.stringify(skill.metadata)}`);
	fields.push(`\t\t\tbody: ${JSON.stringify(skill.body)}`);
	const files = skill.files.map(
		(file) => `\t\t\t\t{ path: ${JSON.stringify(file.path)}, text: ${JSON.stringify(file.text)} }`
	);
	fields.push(files.length ? `\t\t\tfiles: [\n${files.join(',\n')}\n\t\t\t]` : '\t\t\tfiles: []');
	fields.push(`\t\t\torigin: 'workspace'`);
	return `\t\t{\n${fields.join(',\n')}\n\t\t}`;
}

function renderWorkspace(
	structure: PodStructure,
	metadata: { readonly name: string; readonly description: string | null }
): string {
	const imports: string[] = [
		"import { defineRuntimeCollection, defineRuntimeWorkspace } from '@norbital-ai/pod/authoring/internals';",
		"import { apps } from './apps.js';",
		"import { customTypes } from './custom-types.js';",
		"import { registry } from './registry.js';"
	];
	const entries: string[] = [];
	for (const [index, collection] of structure.collections.entries()) {
		const spreads: string[] = [];
		if (collection.roles.hooks) {
			imports.push(
				`import hooks${index} from ${JSON.stringify(generatedImport(collection.roles.hooks))};`
			);
			spreads.push(`hooks${index}`);
		}
		if (collection.roles.pipelines) {
			imports.push(
				`import pipelines${index} from ${JSON.stringify(generatedImport(collection.roles.pipelines))};`
			);
			spreads.push(`pipelines${index}`);
		}
		if (collection.roles.integrations) {
			imports.push(
				`import integrations${index} from ${JSON.stringify(generatedImport(collection.roles.integrations))};`
			);
			spreads.push(`{ integrations: integrations${index} }`);
		}
		entries.push(
			`\tdefineRuntimeCollection(registry, ${JSON.stringify(collection.id)}, [${spreads.join(', ')}])`
		);
	}
	for (const [index, automation] of structure.automations.entries()) {
		imports.push(
			`import automation${index} from ${JSON.stringify(generatedImport(automation.source))};`
		);
	}
	for (const [index, remote] of structure.remotes.entries()) {
		imports.push(`import remote${index} from ${JSON.stringify(generatedImport(remote.source))};`);
	}
	for (const [index, tool] of structure.agentTools.entries()) {
		imports.push(`import agentTool${index} from ${JSON.stringify(generatedImport(tool.source))};`);
	}
	for (const [index, policy] of structure.policies.entries()) {
		imports.push(`import policy${index} from ${JSON.stringify(generatedImport(policy.source))};`);
	}
	for (const [index, channel] of structure.channels.entries()) {
		imports.push(`import channel${index} from ${JSON.stringify(generatedImport(channel.source))};`);
	}
	if (structure.seed) {
		imports.push(`import seed from ${JSON.stringify(generatedImport(structure.seed))};`);
	}
	if (structure.env) {
		imports.push(`import env from ${JSON.stringify(generatedImport(structure.env))};`);
	}
	if (structure.agent) {
		imports.push(`import agent from ${JSON.stringify(generatedImport(structure.agent))};`);
	}
	const automations = structure.automations
		.map((automation, index) => `{ ...automation${index}, name: ${JSON.stringify(automation.id)} }`)
		.join(', ');
	const remotes = structure.remotes
		.map((remote, index) => `\t\t${JSON.stringify(remote.id)}: remote${index}`)
		.join(',\n');
	const agentTools = structure.agentTools
		.map((tool, index) => `\t\t${JSON.stringify(tool.id)}: agentTool${index}`)
		.join(',\n');
	const policies = structure.policies
		.map(
			(policy, index) =>
				`\t\t${JSON.stringify(policy.id)}: { ...policy${index}, key: ${JSON.stringify(policy.id)} }`
		)
		.join(',\n');
	const channels = structure.channels
		.map((channel, index) => `\t\t${JSON.stringify(channel.id)}: channel${index}`)
		.join(',\n');
	const skills = structure.skills.map((skill) => renderSkill(skill)).join(',\n');
	const workspaceMeta = `name: ${JSON.stringify(metadata.name)}${metadata.description ? `, description: ${JSON.stringify(metadata.description)}` : ''}`;
	return `${imports.join('\n')}\n\nexport const workspace = defineRuntimeWorkspace(registry, {\n\tcollections: [\n${entries.join(',\n')}\n\t],\n\tapps,\n\tcustomTypes,\n\tmeta: { ${workspaceMeta} }${structure.agent ? ',\n\tagent' : ''}${structure.automations.length ? `,\n\tautomations: [${automations}]` : ''}${structure.remotes.length ? `,\n\tinvoke: {\n${remotes}\n\t}` : ''}${structure.agentTools.length ? `,\n\tagentTools: {\n${agentTools}\n\t}` : ''}${structure.policies.length ? `,\n\tpolicies: {\n${policies}\n\t}` : ''}${structure.channels.length ? `,\n\tchannels: {\n${channels}\n\t}` : ''}${structure.skills.length ? `,\n\tskills: [\n${skills}\n\t]` : ''}${structure.seed ? ',\n\tseed' : ''}${structure.env ? ',\n\tenv' : ''}\n});\n\nexport type Workspace = typeof workspace;\nexport default workspace;\n`;
}

function renderClient(
	nodes: readonly DiscoveredAppNode[],
	remotes: readonly DiscoveredWorkspaceRole[],
	collections: readonly DiscoveredCollection[]
): string {
	const loaders = nodes
		.filter((node) => node.kind === 'app')
		.map(
			(node) =>
				`\t${JSON.stringify(node.id)}: () => import(${JSON.stringify(generatedImport(node.source))}).then((module) => module.default)`
		)
		.join(',\n');
	const invoke = remotes
		.map(
			(remote) =>
				`\treadonly ${JSON.stringify(remote.id)}: typeof import(${JSON.stringify(generatedImport(remote.source))}).default;`
		)
		.join('\n');
	const hooks = collections
		.filter((collection) => collection.roles.hooks)
		.map((collection) => {
			const source = collection.roles.hooks;
			if (!source) throw new Error(`Collection ${collection.id} has no hooks source.`);
			return `\treadonly ${JSON.stringify(collection.id)}: typeof import(${JSON.stringify(generatedImport(source))}).default;`;
		})
		.join('\n');
	return `import type { CollectionRegistryFor, InvokeClientApi, PlatformSchema } from '@norbital-ai/pod/authoring/internals';\nimport type { CollectionClient } from '@norbital-ai/platform-utils/collection';\nimport { createWorkspaceApiProxy, getInitializedWorkspaceClient } from 'virtual:pod/client-runtime';\nimport type { WorkspaceSchema } from './types.js';\n\ntype CollectionHooks = {\n${hooks}\n};\ntype TenantCollections = CollectionRegistryFor<WorkspaceSchema, CollectionHooks>;\ntype Collections = TenantCollections & CollectionRegistryFor<PlatformSchema>;\ntype Invoke = {\n${invoke}\n};\nconst commands = createWorkspaceApiProxy() as { readonly invoke: InvokeClientApi<Invoke> }; // stupidity: boundary-cast — the private runtime proxy implements the compiler-derived invoke map.\n\nexport type { WorkspaceRow } from './types.js';\nexport type WorkspaceCollections = Collections;\nexport type WorkspaceCreate<N extends keyof TenantCollections> = TenantCollections[N]['create'];\nexport type WorkspaceUpdate<N extends keyof TenantCollections> = TenantCollections[N]['update'];\nexport type Client = {\n\treadonly db: CollectionClient<Collections>['db'];\n\treadonly invoke: typeof commands.invoke;\n};\nexport const client: Client = {\n\tget db() { return getInitializedWorkspaceClient().db as CollectionClient<Collections>['db']; }, // stupidity: boundary-cast — compiler collection keys refine the erased runtime client.\n\tinvoke: commands.invoke\n};\n\nexport const appLoaders = {\n${loaders}\n} as const;\n`;
}

function clientRuntimeTypes(): string {
	return `declare module 'virtual:pod/client-runtime' {\n\timport type { CollectionClient, ErasedCollectionRegistry } from '@norbital-ai/platform-utils/collection';\n\n\texport function createWorkspaceApiProxy(): { readonly db: object; readonly invoke: object };\n\texport function getInitializedWorkspaceClient(): CollectionClient<ErasedCollectionRegistry>;\n}\n`;
}

/**
 * The typed tenant key union, derived from the authored `messages.en.json`.
 *
 * Template app files translate with `useI18n<TenantI18nKeys>()` from
 * `@norbital-ai/ui/i18n`, importing the type from `$pod/i18n-keys`. Without an
 * `src/i18n/` the union is the open `string`, which keeps the default
 * workspace authorable while anything it adds becomes typed.
 */
function renderI18nKeys(i18n: DiscoveredI18n): string {
	const primary = i18n.catalogs[i18n.primary] ?? null;
	const keys = primary ? Object.keys(primary) : [];
	if (keys.length === 0) return 'export type TenantI18nKeys = string;\n';
	return `export type TenantI18nKeys =\n${keys.map((key) => `\t| ${JSON.stringify(key)}`).join('\n')};\n`;
}

function renderWorkspaceTypes(): string {
	return `import type { AfterHookApi as CollectionAfterHookApi, BeforeApi, HookApi as CollectionHookApi, SchemaQueryConfig, SchemaQueryRow } from '@norbital-ai/pod/authoring';\nimport type { InputValuesForTables, MutationInsertFor, TablesForModels } from '@norbital-ai/pod/authoring/internals';\nimport type { Models } from './models.js';\n\nexport type { CustomKind, CustomValue } from './custom-types.js';\ntype WorkspaceTables = TablesForModels<Models>;\nexport type WorkspaceSchema = {\n\treadonly tables: WorkspaceTables;\n\treadonly relations: Readonly<Record<never, never>>;\n\treadonly inputs: InputValuesForTables<WorkspaceTables>;\n};\nexport type Api = BeforeApi<WorkspaceSchema>;\nexport type HookApi = CollectionHookApi<WorkspaceSchema>;\nexport type AfterHookApi = CollectionAfterHookApi<WorkspaceSchema>;\nexport type WorkspaceRow<\n\tN extends keyof WorkspaceSchema['tables'] & string,\n\tCfg extends SchemaQueryConfig<WorkspaceSchema, N> | undefined = undefined\n> = SchemaQueryRow<WorkspaceSchema, N, Cfg>;\n\n/** The payload that creates one row — the counterpart to \`WorkspaceRow\`, for a helper module that writes. */\nexport type WorkspaceInsert<N extends keyof WorkspaceSchema['tables'] & string> = MutationInsertFor<\n\tWorkspaceSchema,\n\tN\n>;\n`;
}

function collectionTypes(collection: DiscoveredCollection): string {
	return `import type { CollectionHooks, CollectionIntegrations, CollectionPipelines } from '@norbital-ai/pod/authoring';\nimport type { WorkspaceRow, WorkspaceSchema } from '../../../generated/types.js';\n\nexport type { AfterHookApi, Api, HookApi, WorkspaceRow } from '../../../generated/types.js';\nexport type Row = WorkspaceRow<${JSON.stringify(collection.id)}>;\nexport type RepresentationProps = { readonly record: Row | null; close(): void; refresh(): Promise<void> };\nexport type Hooks = CollectionHooks<WorkspaceSchema, ${JSON.stringify(collection.id)}>;\nexport type Pipelines = CollectionPipelines<WorkspaceSchema, ${JSON.stringify(collection.id)}>;\nexport type Integrations = CollectionIntegrations<WorkspaceSchema, ${JSON.stringify(collection.id)}>;\n`;
}

function relationshipTypes(): string {
	return `import type { PlatformRelationshipsFor } from '@norbital-ai/pod/authoring/internals';\nimport type { Models } from '../../generated/models.js';\n\nexport type Relationships = PlatformRelationshipsFor<Models>;\n`;
}

/**
 * Shared `$types` for a directory holding automations, remotes, or agent tools.
 *
 * `depth` is how far the emitted file sits below `.norbital/`, so the generated imports resolve from
 * both `types/automation/` and a nested `types/collections/<id>/`.
 */
function workspaceRoleTypes(depth: number): string {
	const up = '../'.repeat(depth);
	return `import type { AutomationContext, AutomationTrigger } from '@norbital-ai/pod/authoring';\nimport type { WorkspaceSchema } from '${up}generated/types.js';\n\nexport type { Api, WorkspaceRow } from '${up}generated/types.js';\nexport type { AgentToolName, CollectionName } from '${up}generated/authoring-types.js';\n\n/** Every trigger this workspace can declare — a checked union of its own collections. */\nexport type Trigger = AutomationTrigger<WorkspaceSchema>;\n\n/** The scope an automation receives for one trigger, with an exact \`incoming_record\`. */\nexport type Scope<T extends Trigger> = AutomationContext<T, WorkspaceSchema>['scope'];\n`;
}

/** `.norbital/types/<segments>/$types.d.ts` for each directory holding a `+<name>.tool.ts`. */
function agentToolTypeFiles(structure: PodStructure): Map<string, string> {
	const files = new Map<string, string>();
	for (const tool of structure.agentTools) {
		const directory = path.posix.dirname(tool.source);
		if (!directory.startsWith('src/')) continue;
		const segments = directory.slice('src/'.length);
		files.set(
			`.norbital/types/${segments}/$types.d.ts`,
			workspaceRoleTypes(segments.split('/').length + 1)
		);
	}
	return files;
}

function generatedAuthoringTypes(structure: PodStructure): string {
	const union = (entries: readonly DiscoveredWorkspaceRole[] | readonly DiscoveredCollection[]) =>
		entries.map((entry) => JSON.stringify(entry.id)).join(' | ') || 'never';
	return [
		`export type CollectionName = ${union(structure.collections)};`,
		`export type AgentToolName = ${union(structure.agentTools)};`,
		`export type PolicyName = ${union(structure.policies)};`,
		`export type AppName = ${union(structure.apps.filter((node) => node.kind === 'app'))};`,
		`export type ChannelName = ${union(structure.channels)};`,
		''
	].join('\n');
}

function workspaceAuthoringTypes(): string {
	return `import type { AgentToolName, AppName, CollectionName, PolicyName } from '../generated/authoring-types.js';\nimport type { WorkspaceSchema } from '../generated/types.js';\n\ndeclare module '@norbital-ai/pod/authoring' {\n\tinterface WorkspaceAuthoringTypes {\n\t\treadonly schema: WorkspaceSchema;\n\t\treadonly collectionName: CollectionName;\n\t\treadonly agentToolName: AgentToolName;\n\t\treadonly policyName: PolicyName;\n\t\treadonly appName: AppName;\n\t}\n}\nexport {};\n`;
}

/** `$types` for `src/channels`, carrying a `Channel` whose `policy` is checked against this workspace. */
function channelTypes(): string {
	return `import type { ChannelDefinition } from '@norbital-ai/pod/authoring';\n\nexport type { ChannelName, PolicyName } from '../../generated/authoring-types.js';\n\n/** Declare with \`satisfies Channel\` so the policy name is checked against this workspace. */\nexport type Channel = ChannelDefinition;\n`;
}

/** `$types` for `src/policies`, carrying a `Policy` bound to this workspace's collections. */
function policyTypes(): string {
	return `import type { PolicyDefinition } from '@norbital-ai/pod/authoring';\nimport type { WorkspaceSchema } from '../../generated/types.js';\n\nexport type { AppName, CollectionName, PolicyName } from '../../generated/authoring-types.js';\n\n/** Declare with \`satisfies Policy\` so collection names and \`where\` columns are exact. */\nexport type Policy = PolicyDefinition<WorkspaceSchema>;\n`;
}

function customTypeTypes(customType: DiscoveredCustomType): string {
	return `import type { CollectionField } from '@norbital-ai/platform-utils/collection';\nimport type { CustomTypeResolvedSchema } from '@norbital-ai/pod/authoring';\nimport type { z } from 'zod';\nimport type definition from '../../../${customType.definition.replace(/\.ts$/, '.js')}';\n\nexport type Value = z.infer<CustomTypeResolvedSchema<typeof definition>>;\nexport type RendererProps =\n\t| { readonly mode: 'display'; readonly field: CollectionField; readonly value: Value | null }\n\t| { readonly mode: 'edit'; readonly field: CollectionField; readonly value: Value | null; readonly disabled: boolean; onValueChange(value: Value | null): void };\n`;
}

function renderTsconfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				allowSyntheticDefaultImports: true,
				esModuleInterop: true,
				lib: ['ES2023', 'DOM', 'DOM.Iterable'],
				module: 'ES2022',
				moduleResolution: 'bundler',
				noEmit: true,
				rootDirs: ['../src', './types', '..'],
				paths: { '$pod/*': ['./generated/*'] },
				customConditions: ['svelte'],
				skipLibCheck: true,
				strict: true,
				target: 'ES2022',
				types: ['vite/client'],
				resolveJsonModule: true
			},
			include: ['../src/**/*.ts', '../src/**/*.svelte', './generated/**/*.ts', './types/**/*.d.ts'],
			exclude: ['../node_modules', './dist']
		},
		null,
		'\t'
	)}\n`;
}

async function packageMetadata(
	root: string
): Promise<
	| { readonly valid: true; readonly name: string; readonly description: string | null }
	| { readonly valid: false; readonly diagnostic: StructuralDiagnostic }
> {
	try {
		const source = await readFile(path.join(root, 'package.json'), 'utf8');
		const value = safeParse(source);
		const name = typeof value === 'object' && value != null ? Reflect.get(value, 'name') : null;
		const description =
			typeof value === 'object' && value != null ? Reflect.get(value, 'description') : null;
		if (typeof name === 'string' && name.length > 0) {
			return {
				valid: true,
				name,
				description: typeof description === 'string' && description.length > 0 ? description : null
			};
		}
		return {
			valid: false,
			diagnostic: topologyDiagnostic(
				'package.json',
				'PACKAGE_NAME_MISSING',
				'package.json requires a non-empty name'
			)
		};
	} catch (error) {
		return {
			valid: false,
			diagnostic: topologyDiagnostic(
				'package.json',
				'PACKAGE_INVALID',
				error instanceof Error ? error.message : 'Unable to read package.json'
			)
		};
	}
}

function diagnosticSnapshot(
	structure: PodStructure,
	mode: 'authoring' | 'build',
	revision: number
): DiagnosticSnapshot {
	return {
		version: 1,
		revision,
		mode,
		status: 'complete',
		summary: {
			files: new Set(structure.diagnostics.map((diagnostic) => diagnostic.file)).size,
			errors: structure.diagnostics.length,
			warnings: 0
		},
		diagnostics: structure.diagnostics
	};
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
	if (existsSync(file) && (await readFile(file, 'utf8')) === content) return false;
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	await writeFile(temporary, content);
	await rename(temporary, file);
	return true;
}

async function existingTypeFiles(directory: string): Promise<string[]> {
	return (await filesBelow(directory)).filter((file) => path.basename(file) === '$types.d.ts');
}

export async function compilePodFilesystem(
	options: PodFilesystemCompilerOptions
): Promise<PodFilesystemCompilation> {
	const root = path.resolve(options.root);
	if (
		!existsSync(path.join(root, 'package.json')) ||
		!existsSync(path.join(root, 'src')) ||
		(!existsSync(path.join(root, 'src/collections')) && !existsSync(path.join(root, 'src/apps')))
	) {
		const diagnostic = topologyDiagnostic(
			'.',
			'POD_ROOT_INVALID',
			'Pod synchronization must run from a workspace root containing package.json and the src/collections or src/apps topology'
		);
		const structure: PodStructure = {
			version: 1,
			relationships: null,
			collections: [],
			customTypes: [],
			apps: [],
			automations: [],
			agent: null,
			remotes: [],
			policies: [],
			channels: [],
			agentTools: [],
			skills: [],
			i18n: { present: false, catalogs: {}, primary: DEFAULT_LOCALE, en: null, zh: null },
			seed: null,
			env: null,
			diagnostics: [diagnostic]
		};
		return {
			valid: false,
			structure,
			diagnostics: structure.diagnostics,
			written: [],
			removed: []
		};
	}
	const discovered = await discoverPodFilesystem(root);
	const metadata = await packageMetadata(root);
	const structure: PodStructure = metadata.valid
		? discovered
		: {
				...discovered,
				diagnostics: [...discovered.diagnostics, metadata.diagnostic].sort(
					(left, right) => compareText(left.file, right.file) || compareText(left.code, right.code)
				)
			};
	const generatedStateRoot = path.join(root, '.norbital');
	const debugFiles = new Map([
		['.norbital/diagnosis/structure.json', `${JSON.stringify(structure, null, '\t')}\n`],
		[
			'.norbital/diagnosis/diagnostics.json',
			`${JSON.stringify(
				diagnosticSnapshot(structure, options.mode ?? 'authoring', options.revision ?? 0),
				null,
				'\t'
			)}\n`
		]
	]);
	const written: string[] = [];
	const removed: string[] = [];

	if (structure.diagnostics.length === 0 && metadata.valid) {
		const generated = new Map<string, string>([
			['.norbital/generated/models.ts', renderModels(structure.collections)],
			['.norbital/generated/registry.ts', renderRegistry(structure.collections)],
			['.norbital/generated/apps.ts', renderApps(structure.apps)],
			['.norbital/generated/custom-types.ts', renderCustomTypes(structure.customTypes)],
			[
				'.norbital/generated/collection-surfaces.ts',
				renderCollectionSurfaces(structure.collections)
			],
			[
				'.norbital/generated/custom-type-renderers.ts',
				renderCustomTypeRenderers(structure.customTypes)
			],
			['.norbital/generated/workspace.ts', renderWorkspace(structure, metadata)],
			[
				'.norbital/generated/client.ts',
				renderClient(structure.apps, structure.remotes, structure.collections)
			],
			['.norbital/generated/types.ts', renderWorkspaceTypes()],
			['.norbital/generated/authoring-types.ts', generatedAuthoringTypes(structure)],
			['.norbital/generated/i18n-keys.ts', renderI18nKeys(structure.i18n)],
			['.norbital/types/collections/$types.d.ts', relationshipTypes()],
			['.norbital/types/policies/$types.d.ts', policyTypes()],
			['.norbital/types/channels/$types.d.ts', channelTypes()],
			['.norbital/types/automation/$types.d.ts', workspaceRoleTypes(2)],
			['.norbital/types/remotes/$types.d.ts', workspaceRoleTypes(2)],
			['.norbital/types/workspace-authoring.d.ts', workspaceAuthoringTypes()],
			['.norbital/types/client-runtime.d.ts', clientRuntimeTypes()],
			['.norbital/types/custom-type-values.d.ts', renderCustomTypeValueMap(structure.customTypes)],
			['.norbital/tsconfig.json', renderTsconfig()]
		]);
		// Tool directories first: a collection directory holding a tool keeps its richer collection
		// types, which already carry `Api`.
		for (const [file, content] of agentToolTypeFiles(structure)) generated.set(file, content);
		for (const collection of structure.collections) {
			generated.set(
				`.norbital/types/collections/${collection.id}/$types.d.ts`,
				collectionTypes(collection)
			);
		}
		for (const customType of structure.customTypes) {
			generated.set(
				`.norbital/types/custom-types/${customType.id}/$types.d.ts`,
				customTypeTypes(customType)
			);
		}
		const expectedTypes = new Set(
			[...generated.keys()]
				.filter((file) => file.endsWith('/$types.d.ts'))
				.map((file) => path.join(root, file))
		);
		// stupidity:allow A6 -- stale generated types are removed before replacement files are written.
		for (const staleFile of await existingTypeFiles(path.join(generatedStateRoot, 'types'))) {
			if (expectedTypes.has(staleFile)) continue;
			await rm(staleFile);
			removed.push(relativePath(root, staleFile));
		}

		// stupidity:allow A6 -- generated files publish in stable map order.
		for (const [file, content] of generated) {
			if (await writeIfChanged(path.join(root, file), content)) written.push(file);
		}
	}

	// stupidity:allow A6 -- diagnostics publish after generated source files.
	for (const [file, content] of debugFiles) {
		if (await writeIfChanged(path.join(root, file), content)) written.push(file);
	}

	return {
		valid: structure.diagnostics.length === 0,
		structure,
		diagnostics: structure.diagnostics,
		written: written.sort(compareText),
		removed: removed.sort(compareText)
	};
}
