/// <reference types="node" />
// Loading: import each role's default export and gather the manifest, keyed by role then path-derived name.
import { Array, Effect, FileSystem, Path, Predicate, Schema } from 'effect';
import { pathToFileURL } from 'node:url';
import { type Diagnostic, type Discovered, sourcePath } from './discover.ts';
import { writeDeclarations } from './declarations.ts';
import { ROLES, type LoadedManifest as Manifest } from '@norbital-ai/bolt/tooling';
import { SYSTEM_COLUMNS } from '@norbital-ai/store'; // hook:write
import { tree_digest } from '@norbital-ai/bolt/artifact';
import { SKILL_BYTES, SKILL_FILE } from '@norbital-ai/bolt/engine';

export type { LoadedManifest as Manifest } from '@norbital-ai/bolt/tooling';

// Plain `import()` in the build process, for the compiler tests and the non-code roles; `bolt check` evaluates code roles in
// the isolate instead (frozen clock, seeded random, twice, hash compare; check/index.ts).
class LoadError extends Schema.TaggedError<LoadError>()('LoadError', {
	path: Schema.String,
	cause: Schema.Defect()
}) {}

/** A skill's folder as its tree: `+skill.md` is its `SKILL.md`; dot-files are not part of it; a link is refused. */
const skillTree = Effect.fnUntraced(function* (
	abs: string,
	file: string,
	text: string,
	fail: (code: Diagnostic['code'], path: string, message: string) => void
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = path.dirname(abs),
		real = yield* fs.realPath(dir);
	const files: (readonly [string, Uint8Array])[] = [];
	let bytes = 0;
	for (const entry of yield* fs.readDirectory(dir, { recursive: true })) {
		const at = path.join(dir, entry),
			name = entry.split(path.sep).join('/');
		if (name.split('/').some((part) => part.startsWith('.'))) continue;
		if ((yield* fs.realPath(at)) !== path.join(real, entry)) {
			fail('load/skill-link', file, `${name} is a link; a skill holds its own files`);
			continue;
		}
		if ((yield* fs.stat(at)).type !== 'File') continue;
		if (name === SKILL_FILE) {
			fail('load/skill-file', file, `the skill's ${SKILL_FILE} is its +skill.md; remove ${name}`);
			continue;
		}
		const content = name === '+skill.md' ? new TextEncoder().encode(text) : yield* fs.readFile(at);
		bytes += content.byteLength;
		files.push([name === '+skill.md' ? SKILL_FILE : name, content]);
	}
	if (bytes > SKILL_BYTES)
		fail(
			'load/skill-size',
			file,
			`a skill is at most ${SKILL_BYTES / 1024 / 1024} MiB (this one is ${bytes} bytes)`
		);
	return { text, digest: tree_digest(files), files: files.map(([name]) => name).sort() };
});

export const load = Effect.fn('bolt.load')(function* (root: string, files: readonly Discovered[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (files.some((file) => file.role === 'model' || file.role === 'integration_definition'))
		yield* writeDeclarations(root, files);
	const manifest: Manifest = yield* Schema.decodeUnknownEffect(
		Schema.Record(
			Schema.Literals(ROLES.map((r) => r.role)),
			Schema.Record(Schema.String, Schema.Unknown)
		)
	)(Object.fromEntries(ROLES.map((r) => [r.role, {}])));
	const errors: Diagnostic[] = [];
	const fail = (code: Diagnostic['code'], path: string, message: string) =>
		errors.push({ code, path, message: `${path}: ${message}` });
	for (const f of files) {
		const abs = path.join(root, f.path);
		if (f.path.endsWith('.svelte')) manifest[f.role][f.name] = f.path;
		else if (f.path.endsWith('.md')) {
			const text = yield* fs.readFileString(abs);
			if (f.role === 'skill' && !/^---\n(?:.*\n)*?description:\s*\S.*\n(?:.*\n)*?---/.test(text))
				fail(
					'load/skill-description',
					f.path,
					'a skill starts with frontmatter holding `description:`'
				);
			manifest[f.role][f.name] =
				f.role === 'skill' ? yield* skillTree(abs, f.path, text, fail) : text;
		} else {
			const loaded = yield* Effect.tryPromise({
				try: (): Promise<unknown> => import(pathToFileURL(abs).href),
				catch: (cause) => new LoadError({ path: f.path, cause })
			}).pipe(Effect.result);
			if (loaded._tag === 'Failure') {
				fail(
					'load/failed',
					f.path,
					loaded.failure.cause instanceof Error
						? loaded.failure.cause.message
						: String(loaded.failure.cause)
				);
				continue;
			}
			const declaration = Predicate.isObject(loaded.success)
				? loaded.success['default']
				: undefined;
			if (declaration === undefined)
				fail('load/no-default', f.path, `default-export the ${f.role} declaration`);
			else manifest[f.role][f.name] = declaration;
		}
	}
	return { manifest, errors };
});

/**
 * The manifest-level checks of a loaded manifest (names against paths, integration definitions, listed pages). A workspace
 * may not reach into the built-in layer: `table` is a system model's.
 */
export function manifestErrors(
	manifest: Manifest,
	layer: 'workspace' | 'system' = 'workspace',
	files: readonly Discovered[] = []
): Diagnostic[] {
	const errors: Diagnostic[] = [];
	const fail = (code: Diagnostic['code'], path: string, message: string) =>
		errors.push({ code, path, message: `${path}: ${message}` });
	// A generated declaration binding carries its path-derived name, checked against the file being loaded.
	for (const role of NAMED) {
		for (const [name, d] of Object.entries(manifest[role] ?? {})) {
			const declared = Predicate.isObject(d) ? d['name'] : undefined;
			if (declared !== name)
				fail(
					'load/name-path',
					sourcePath(role, name, files),
					`uses the ${CALLS[role]} binding for '${String(declared)}'; its path names it '${name}'`
				);
		}
	}
	// Source access declarations own both hierarchy and policy composition.
	const teams = manifest.team[''];
	const secrets = manifest.secrets?.[''];
	if (secrets !== undefined) {
		if (!Predicate.isObject(secrets))
			fail(
				'load/secrets-shape',
				sourcePath('secrets', ''),
				'secret declarations are a map of names'
			);
		else
			for (const [name, declaration] of Object.entries(secrets))
				if (
					!/^[A-Z][A-Z0-9_]*$/.test(name) ||
					!Predicate.isObject(declaration) ||
					typeof declaration['label'] !== 'string' ||
					(declaration['description'] !== undefined &&
						typeof declaration['description'] !== 'string') ||
					Object.keys(declaration).some((key) => key !== 'label' && key !== 'description')
				)
					fail(
						'load/secrets-shape',
						sourcePath('secrets', ''),
						`'${name}' declares a label and optional description; its value is supplied at runtime`
					);
	}
	if (teams !== undefined) {
		const path = sourcePath('team', '');
		if (!Predicate.isObject(teams))
			fail('load/team-shape', path, 'team declarations are a map of stable handles');
		else {
			const parents = new Map<string, string>();
			for (const [handle, entry] of Object.entries(teams)) {
				if (!Predicate.isReadonlyObject(entry) || Array.isArray(entry)) {
					fail('load/team-shape', path, `team '${handle}' declares an object with its policy list`);
					continue;
				}
				const policies = entry['policies'];
				if (
					!handle.trim() ||
					!Array.isArray(policies) ||
					!policies.every(Predicate.isString) ||
					Object.keys(entry).some((key) => key !== 'name' && key !== 'parent' && key !== 'policies')
				) {
					fail('load/team-shape', path, `team '${handle}' declares its policy list`);
					continue;
				}
				for (const policy of policies)
					if (!Object.hasOwn(manifest.policy, policy))
						fail('load/team-policy', path, `team '${handle}' names unknown policy '${policy}'`);
				if (
					entry['name'] !== undefined &&
					(typeof entry['name'] !== 'string' || !entry['name'].trim())
				)
					fail('load/team-name', path, `team '${handle}' has a nonempty display name`);
				const parent = entry['parent'];
				if (parent !== undefined && parent !== null) {
					if (typeof parent !== 'string' || !Object.hasOwn(teams, parent))
						fail('load/team-parent', path, `team '${handle}' names an existing parent handle`);
					else parents.set(handle, parent);
				}
			}
			for (const handle of parents.keys()) {
				const seen = new Set<string>();
				let current: string | undefined = handle;
				while (current !== undefined) {
					if (seen.has(current)) {
						fail('load/team-cycle', path, `team '${handle}' has a cyclic hierarchy`);
						break;
					}
					seen.add(current);
					current = parents.get(current);
				}
			}
		}
	}
	// hook:write — every row carries the system columns; a model field of the same name would shadow one (`revision` is the
	// row version every update checks), so it is refused here rather than as a duplicate column at migration
	if (layer === 'workspace') {
		for (const [name, d] of Object.entries(manifest.model)) {
			const literal = spec(d);
			for (const f of Object.keys(Predicate.isObject(literal['fields']) ? literal['fields'] : {}))
				if (SYSTEM_COLUMNS.some((column) => column === f))
					fail(
						'load/reserved-field',
						sourcePath('model', name, files),
						`'${f}' is a system column on every row (${SYSTEM_COLUMNS.join(', ')}); name the field for what it holds, e.g. '${name.replace(/s$/, '')}_${f}'`
					);
			if (literal['table'] !== undefined)
				fail(
					'load/system-only',
					sourcePath('model', name, files),
					'`table` describes a built-in system table; a workspace model takes the engine columns'
				);
		}
	}
	for (const [name, app] of Object.entries(manifest.app)) {
		const path = sourcePath('app', name, files);
		if (!Predicate.isObject(app) || !Predicate.isObject(app['pages'])) {
			fail('app/shape', path, `app '${name}' declares a pages map`);
			continue;
		}
		for (const page of Object.keys(app['pages']))
			if (!Object.hasOwn(manifest.page, `${name}/${page}`))
				fail('app/page-missing', path, `app '${name}' lists '${page}' without a page file`);
	}
	for (const [name, group] of Object.entries(manifest.group)) {
		const child = Predicate.isObject(group) ? group['default_child'] : undefined;
		if (
			typeof child !== 'string' ||
			child.includes('/') ||
			(!Object.hasOwn(manifest.app, `${name}/${child}`) &&
				!Object.hasOwn(manifest.group, `${name}/${child}`))
		)
			fail(
				'app/group-child',
				sourcePath('group', name, files),
				`group '${name}' must name a direct default_child`
			);
	}
	// `app/page-unlisted`: every page file has an entry in its app's `pages`, whose key order is nav order.
	for (const page of Object.keys(manifest.page ?? {})) {
		const at = page.lastIndexOf('/');
		const app = manifest.app[page.slice(0, at)];
		const pages = Predicate.isObject(app) ? app['pages'] : undefined;
		if (Predicate.isObject(pages) && !Object.hasOwn(pages, page.slice(at + 1)))
			fail(
				'app/page-unlisted',
				String(manifest.page[page]),
				`app '${page.slice(0, at)}' lists no page '${page.slice(at + 1)}' in pages`
			);
	}
	return errors;
}

/** The literal of a body declaration, or the export itself. */
export function spec(d: unknown): { readonly [key: string]: unknown } {
	if (!Predicate.isReadonlyObject(d)) return {};
	return Predicate.isReadonlyObject(d['spec']) ? d['spec'] : d;
}

/** Roles whose generated declaration binding carries a path identity. */
const NAMED = ['model', 'integration_definition'] as const;
const CALLS: { readonly [R in (typeof NAMED)[number]]: string } = {
	model: 'model',
	integration_definition: 'integration'
};
