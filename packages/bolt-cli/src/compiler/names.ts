/// <reference types="node" />
// The names index: `.norbital/names.ts` and path-bound declaration modules. `bolt sync` evaluates the declarations and
// prints each part's data as literal type text (strings and numbers as literals, arrays as readonly tuples, bodies
// dropped); a model is printed as its three parts (`split_model`). No part reads a source file, so a body typed from the
// index is never circular; the path-derived parts (pages, groups, skills) are unions of names.
import { Effect, FileSystem, Path, Predicate } from 'effect';
import type { Discovered } from './discover.ts';
import { layer_models, literal, split_model, SYSTEM } from '@norbital-ai/bolt/tooling';
import { type Manifest, spec } from './load.ts';

type ModelParts = ReturnType<typeof split_model>;
type RelationshipSpec = ModelParts['relationships'][string];

const key = JSON.stringify;
const record = (entries: readonly (readonly [string, string])[], indent: string) =>
	entries.length === 0
		? '{}'
		: `{\n${[...entries]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([k, v]) => `${indent}\t${key(k)}: ${v};`)
				.join('\n')}\n${indent}}`;

/** Each model's three parts, by name; a literal that is no model literal is refused (`check` keeps the last good index). */
export function modelParts(models: { readonly [name: string]: unknown }): [string, ModelParts][] {
	return Object.entries(models).map(([name, d]) => [name, split_model(name, spec(d))]);
}
/**
 * The three model parts as `Names` parts, and `layers`: each exposed model's declared paths below its root → the model
 * behind each, resolved over `extra` relationships too (the built-in layer's). A path that resolves to nothing is left out
 * (`bolt check` names it, `model/layer`).
 */
function modelTypes(
	models: { readonly [name: string]: unknown },
	indent: string,
	extra: { readonly [key: string]: RelationshipSpec } = {}
) {
	const parts = modelParts(models);
	const relationships: { readonly [key: string]: RelationshipSpec } = Object.fromEntries([
		...Object.entries(extra),
		...parts.flatMap(([, p]) => Object.entries(p.relationships))
	]);
	return {
		layers: record(
			parts.flatMap(([name, p]): [string, string][] => {
				if (p.exposure === undefined) return [];
				const deep = Object.entries(layer_models(name, p.exposure, relationships).models).filter(
					([path]) => path !== name
				);
				return deep.length === 0 ? [] : [[name, literal(Object.fromEntries(deep), `${indent}\t`)]];
			}),
			indent
		),
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
		exposures: record(
			parts.flatMap(([name, p]): [string, string][] =>
				p.exposure === undefined ? [] : [[name, literal(p.exposure, `${indent}\t`)]]
			),
			indent
		)
	};
}

/** `Names` part → the role whose evaluated declarations it prints: `spec` parts wrap each literal as `{ spec }`. */
const PARTS: { part: string; role: Discovered['role']; shape: 'each' | 'spec' | 'one' }[] = [
	{ part: 'apps', role: 'app', shape: 'each' },
	{ part: 'automations', role: 'automation', shape: 'spec' },
	{ part: 'integrations', role: 'integration_definition', shape: 'spec' },
	{ part: 'custom_fields', role: 'custom_field', shape: 'spec' },
	{ part: 'mcp', role: 'mcp', shape: 'each' },
	{ part: 'locales', role: 'locale', shape: 'each' },
	{ part: 'messages', role: 'messages', shape: 'one' },
	{ part: 'policies', role: 'policy', shape: 'each' },
	{ part: 'teams', role: 'team', shape: 'one' },
	{ part: 'workspace', role: 'workspace', shape: 'one' },
	{ part: 'secrets', role: 'secrets', shape: 'one' }
];

/**
 * The tools a host advertises: the render facility's browser, web search and a host's workbench authoring.
 * ponytail: one declared list for every host; read the host port's manifest when hosts advertise different tools.
 */
const HOST_TOOLS = [
	'browser_act',
	'browser_close',
	'browser_download',
	'browser_evaluate',
	'browser_navigate',
	'browser_screenshot',
	'browser_snapshot',
	'http',
	'reference',
	'web_search',
	'workspace_commit',
	'workspace_diagnose',
	'workspace_edit',
	'workspace_lang',
	'workspace_move',
	'workspace_patch',
	'workspace_preview',
	'workspace_review',
	'workspace_test',
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
		const first = of.at(0);
		if (first === undefined) continue;
		lines.set(
			part,
			shape === 'one'
				? literal(first[1], t)
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
		for (const [part, text] of Object.entries(modelTypes(manifest.model, t, SYSTEM.relationships)))
			if (part !== 'layers' || text !== '{}') lines.set(part, text);
	// pages: app → union of its page names; groups: group → union of its child app and group folder names.
	const children = (parts: Discovered['role'][], of: string, name: (f: Discovered) => string) =>
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
		'host_tools',
		record(
			HOST_TOOLS.map((tool) => [tool, 'true']),
			t
		)
	);

	return `// Generated by \`bolt sync\` from the evaluated declarations: the names index. Never edited.
import type { Check, Verify } from ${key(bolt)};

declare module ${key(bolt)} {
	interface Names {
${[...lines]
	.sort(([a], [b]) => (a < b ? -1 : 1))
	.map(([part, type]) => `\t\t${part}: ${type};`)
	.join('\n')}
	}
}

// Every cross-file declaration error of the workspace fails here (X-12).
export const __verify: Check<Verify> = true;
`;
}

/** Writes `.norbital/names.ts` only when its text changes; returns whether it wrote. */
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
 * The generated type setup: the workspace `tsconfig.json` extends `.norbital/tsconfig.json`, which carries the
 * compiler options and includes the names index and `bolt.d.ts` for `?bytes` imports. A
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
const BOLT_DTS = `// Generated by bolt. Never edited.
// a server asset: the file's bytes, read synchronously in the isolate
declare module '*?bytes' {
	const bytes: Uint8Array;
	export default bytes;
}
/** Brands \`{ id, name, mime }\` as a stored-file handle for guest writes (prelude; not \`/client\`). */
declare function file_ref(file: { readonly id: string; readonly name: string; readonly mime: string }): import('@norbital-ai/bolt').FileRef;
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
