/// <reference types="node" />
// The names index (§3.1, rule 8): `.norbital/names.ts`, the only generated code. `bolt sync` evaluates the declarations and
// prints each part's data as literal type text (strings and numbers as literals, arrays as readonly tuples, bodies
// dropped); a model is printed as its three parts (`splitModel`). No part reads a source file, so a body typed from the
// index is never circular; the path-derived parts (pages, groups, skills) are unions of names.
import { Array, Effect, FileSystem, Path, Predicate } from 'effect';
import type { Discovered } from './discover.ts';
import type { Role } from '../decl/layout.ts';
import { splitModel, type ModelLiteral, type ModelParts } from '../decl/model.ts';
import { type Manifest, spec } from './load.ts';

const key = JSON.stringify;
/**
 * Data as literal type text: strings, numbers, booleans and `null` as literals, arrays as `readonly` tuples, objects
 * with their keys quoted. A function (a body) or `undefined` is not data: an object drops it, a tuple types it `unknown`.
 */
export function literal(value: unknown, indent = ''): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return key(value);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return `readonly [${value.map((v) => literal(v, indent)).join(', ')}]`;
	if (!Predicate.isObject(value)) return 'unknown';
	const inner = `${indent}\t`;
	const entries = Object.entries(value).filter(
		([, v]) => v !== undefined && typeof v !== 'function'
	);
	return entries.length === 0
		? '{}'
		: `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${literal(v, inner)};`).join('\n')}\n${indent}}`;
}
const record = (entries: readonly (readonly [string, string])[], indent: string) =>
	entries.length === 0
		? '{}'
		: `{\n${[...entries]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([k, v]) => `${indent}\t${key(k)}: ${v};`)
				.join('\n')}\n${indent}}`;

const isModelLiteral = (u: unknown): u is ModelLiteral =>
	Predicate.isObject(u) && typeof u['description'] === 'string' && Predicate.isObject(u['fields']);
/** Each model's three parts, by name; a literal that is no model literal is refused (`check` keeps the last good index). */
export function modelParts(models: { readonly [name: string]: unknown }): [string, ModelParts][] {
	return Object.entries(models).map(([name, d]) => {
		const literal = spec(d);
		if (!isModelLiteral(literal)) throw new Error(`model '${name}' declares no model literal`);
		return [name, splitModel(name, literal)];
	});
}
/** The three model parts as `Names` parts. */
function modelTypes(models: { readonly [name: string]: unknown }, indent: string) {
	const parts = modelParts(models);
	return {
		models: record(
			parts.map(([name, p]) => [name, literal(p.model, `${indent}\t`)]),
			indent
		),
		relationships: record(
			parts.flatMap(([, p]) =>
				Object.entries(p.relationships).map(([k, r]): [string, string] => [
					k,
					literal(r, `${indent}\t`)
				])
			),
			indent
		),
		collections: record(
			parts.flatMap(([name, p]): [string, string][] =>
				p.collection === undefined ? [] : [[name, literal(p.collection, `${indent}\t`)]]
			),
			indent
		)
	};
}

/** `Names` part → the role whose evaluated declarations it prints: `spec` parts wrap each literal as `{ spec }`. */
const PARTS: { part: string; role: Role; shape: 'each' | 'spec' | 'one' }[] = [
	{ part: 'apps', role: 'app', shape: 'each' },
	{ part: 'kiosks', role: 'kiosk', shape: 'each' },
	{ part: 'automations', role: 'automation', shape: 'spec' },
	{ part: 'integrations', role: 'integration_definition', shape: 'spec' },
	{ part: 'envoys', role: 'envoy', shape: 'each' },
	{ part: 'customFields', role: 'custom_field', shape: 'spec' },
	{ part: 'mcp', role: 'mcp', shape: 'each' },
	{ part: 'locales', role: 'locale', shape: 'each' },
	{ part: 'messages', role: 'messages', shape: 'one' },
	{ part: 'policies', role: 'policy', shape: 'each' },
	{ part: 'teams', role: 'team', shape: 'one' },
	{ part: 'workspace', role: 'workspace', shape: 'one' },
	{ part: 'secrets', role: 'secrets', shape: 'one' }
];

/**
 * The tools a host advertises (rule 58): the render facility's browser, web search and a host's workbench authoring.
 * ponytail: one declared list for every host; read the host port's manifest when hosts advertise different tools.
 */
const HOST_TOOLS = [
	'browser_act',
	'browser_download',
	'browser_evaluate',
	'browser_navigate',
	'browser_screenshot',
	'browser_snapshot',
	'http',
	'reference',
	'web_search',
	'workspace_diagnose',
	'workspace_lang',
	'workspace_review',
	'workspace_validate',
	'workspace_write'
] as const;

/**
 * The text of `.norbital/names.ts` from the evaluated declarations (`manifest`); `bolt` is the module the index augments,
 * as seen from `.norbital/`. Throws when a model literal cannot be split: the caller keeps the last good index.
 */
export function namesIndex(
	files: readonly Discovered[],
	manifest: Manifest,
	bolt = '@norbital-ai/bolt'
): string {
	const t = '\t\t';
	const lines = new Map<string, string>();
	for (const { part, role, shape } of PARTS) {
		const of = Object.entries(manifest[role]);
		if (of.length === 0) continue;
		lines.set(
			part,
			shape === 'one'
				? literal(of[0]![1], t)
				: record(
						of.map(([name, d]): [string, string] => [
							name,
							shape === 'spec' ? `{ spec: ${literal(spec(d), `${t}\t`)} }` : literal(d, `${t}\t`)
						]),
						t
					)
		);
	}
	if (Object.keys(manifest.model).length > 0)
		for (const [part, text] of Object.entries(modelTypes(manifest.model, t))) lines.set(part, text);
	// pages: app → union of its page names; groups: group → union of its child app and group folder names.
	const children = (parts: Role[], of: string, name: (f: Discovered) => string) =>
		files
			.filter(
				(f) =>
					parts.includes(f.role) && f.name.slice(0, Math.max(0, f.name.lastIndexOf('/'))) === of
			)
			.map((f) => key(name(f)))
			.sort()
			.join(' | ') || 'never';
	const leaf = (f: Discovered) => f.name.slice(f.name.lastIndexOf('/') + 1);
	const apps = files.filter((f) => f.role === 'app');
	if (files.some((f) => f.role === 'page'))
		lines.set(
			'pages',
			record(
				apps.map((a) => [a.name, children(['page'], a.name, leaf)]),
				t
			)
		);
	const kiosks = files.filter((f) => f.role === 'kiosk');
	if (files.some((f) => f.role === 'kiosk_page'))
		lines.set(
			'kioskPages',
			record(
				kiosks.map((k) => [k.name, children(['kiosk_page'], k.name, leaf)]),
				t
			)
		);
	const groups = files.filter((f) => f.role === 'group');
	if (groups.length > 0)
		lines.set(
			'groups',
			record(
				groups.map((g) => [g.name, children(['app', 'group'], g.name, leaf)]),
				t
			)
		);
	const skills = files.filter((f) => f.role === 'skill');
	if (skills.length > 0)
		lines.set(
			'skills',
			record(
				skills.map((f) => [f.name, 'true']),
				t
			)
		);
	lines.set(
		'hostTools',
		record(
			HOST_TOOLS.map((tool) => [tool, 'true']),
			t
		)
	);

	return `// Generated by \`bolt sync\` from the evaluated declarations: the names index (rule 8). Never edited.
import type { Check, Verify } from ${key(bolt)};

declare module ${key(bolt)} {
	interface Names {
${[...lines]
	.sort(([a], [b]) => (a < b ? -1 : 1))
	.map(([part, type]) => `\t\t${part}: ${type};`)
	.join('\n')}
	}
}

// Every cross-file declaration error of the workspace fails here (§3.3.9, X-12).
export const __verify: Check<Verify> = true;
`;
}

/**
 * The built-in layer's index, `src/system/index.ts`: bolt's own models and conversation integration definitions,
 * discovered under `src/system` exactly as a workspace's are (`discover(root, 'system')`) and loaded (`manifest`). Its
 * names are printed as a workspace's names index prints them (literal data, each model as its three parts); `SYSTEM`
 * splits the imported declarations at load, so the schema plan, the catalogue and the names types merge the same layer
 * into every workspace. A test compares the file with this text.
 */
export function systemIndex(files: readonly Discovered[], manifest: Manifest): string {
	const rel = (f: Discovered) => `./${f.path.slice('src/system/'.length)}`;
	const of = (role: Role) =>
		files.filter((f) => f.role === role).sort((a, b) => (a.name < b.name ? -1 : 1));
	const models = of('model'),
		integrations = of('integration_definition');
	const types = modelTypes(manifest.model, '\t');
	return `// Generated by bolt from the declarations under src/system (\`systemIndex\`, compiler/names.ts): the built-in layer,
// compiled as a workspace is. Never edited; tests/system-layer.test.ts fails when it drifts from the declarations.
import { splitModel, type CollectionSpec, type ModelParts, type ModelSpec } from '../decl/model.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { IntegrationSpec } from '../decl/runtime/integration.ts';
${[
	...models.map((f) => `import m_${f.name} from ${key(rel(f))};`),
	...integrations.map((f) => `import i_${f.name} from ${key(rel(f))};`)
].join('\n')}

/** The layer's names index, printed as a workspace's \`.norbital/names.ts\` prints one. */
export type SystemNames = {
	models: ${types.models};
	relationships: ${types.relationships};
	collections: ${types.collections};
	integrations: ${record(
		integrations.map((f) => [
			f.name,
			`{ spec: ${literal(spec(manifest.integration_definition[f.name]), '\t\t')} }`
		]),
		'\t'
	)};
};
const parts = [${models.map((f) => `m_${f.name}`).join(', ')}].map((m): [string, ModelParts] => [
	m.name,
	splitModel(m.name, m.spec)
]);
/** The layer's manifest: merged into every workspace's schema plan, catalogue and names. */
export const SYSTEM: {
	models: { readonly [model: string]: ModelSpec };
	relationships: { readonly [key: string]: RelationshipSpec };
	collections: { readonly [collection: string]: CollectionSpec };
	integrations: { readonly [integration: string]: IntegrationSpec };
} = {
	models: Object.fromEntries(parts.map(([name, p]): [string, ModelSpec] => [name, p.model])),
	relationships: Object.fromEntries(parts.flatMap(([, p]) => Object.entries(p.relationships))),
	collections: Object.fromEntries(
		parts.flatMap(([name, p]): [string, CollectionSpec][] =>
			p.collection === undefined ? [] : [[name, p.collection]]
		)
	),
	integrations: {
${integrations.map((f) => `\t\t${f.name}: i_${f.name}.spec,`).join('\n')}
	}
};
`;
}

/** Writes `.norbital/names.ts` only when its text changes (rule 8); returns whether it wrote. */
export const writeNames = Effect.fn('bolt.writeNames')(function* (root: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const target = path.join(root, '.norbital', 'names.ts');
	if ((yield* fs.exists(target)) && (yield* fs.readFileString(target)) === text) return false;
	yield* fs.makeDirectory(path.join(root, '.norbital'), { recursive: true });
	yield* fs.writeFileString(target, text);
	return true;
});

/**
 * The generated type setup (§3.1): the workspace `tsconfig.json` extends `.norbital/tsconfig.json`, which carries the
 * compiler options and includes the names index and `bolt.d.ts`, the `$bolt` alias of `@norbital-ai/bolt/page` and `?bytes` imports. A
 * workspace writes no declaration of its own. Each file is written only when its text changes.
 */
const TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: 'ES2024',
			module: 'ESNext',
			moduleResolution: 'bundler',
			strict: true,
			exactOptionalPropertyTypes: true,
			noUncheckedIndexedAccess: true,
			verbatimModuleSyntax: true,
			allowImportingTsExtensions: true,
			resolveJsonModule: true,
			skipLibCheck: true,
			noEmit: true
		},
		include: [
			'../src/**/*.ts',
			'../src/**/*.svelte',
			'../seed/**/*.ts',
			'../tests/**/*.ts',
			'names.ts',
			'bolt.d.ts'
		]
	},
	null,
	'\t'
)}\n`;
const BOLT_DTS = `// Generated by bolt: \`$bolt\` is the booted page SDK and the ui edge it runs on (§3.5, D9). Never edited.
declare module '$bolt' {
	export { attach, bolt, fork, run } from '@norbital-ai/bolt/page';
}
// a server asset (§5.8): the file's bytes, read synchronously in the isolate
declare module '*?bytes' {
	const bytes: Uint8Array;
	export default bytes;
}
/** Brands \`{ id, name, mime }\` as a stored-file handle for guest writes (prelude; not \`/client\`). */
declare function fileRef(file: { readonly id: string; readonly name: string; readonly mime: string }): import('@norbital-ai/bolt').FileRef;
`;
export const writeTypeSetup = Effect.fn('bolt.writeTypeSetup')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = path.join(root, '.norbital');
	yield* fs.makeDirectory(dir, { recursive: true });
	for (const [file, text] of [
		['tsconfig.json', TSCONFIG],
		['bolt.d.ts', BOLT_DTS]
	] as const) {
		const target = path.join(dir, file);
		if (!(yield* fs.exists(target)) || (yield* fs.readFileString(target)) !== text)
			yield* fs.writeFileString(target, text);
	}
});
