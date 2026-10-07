/// <reference types="node" />
// Loading (§3.2, rule 2): import each role's default export and gather the manifest, keyed by role then path-derived name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Diagnostic, type Discovered, ROLES, type Role } from './discover.ts';
import { SYSTEM_COLUMNS } from '../protocol/catalog.ts'; // hook:write
import { SYSTEM } from '../system/index.ts';

/**
 * `manifest[role][name]`: a `.ts` role's default export (declarations are data), a `.md` role's text, a `.svelte`
 * role's path (the bundler compiles it).
 */
export type Manifest = { [R in Role]: Record<string, unknown> };

// Plain `import()` in the build process, for the compiler tests and the non-code roles; `bolt check` evaluates code roles in
// the isolate instead (rule 2: frozen clock, seeded random, twice, hash compare; check/index.ts).
export async function load(root: string, files: readonly Discovered[], layer: 'workspace' | 'system' = 'workspace'): Promise<{ manifest: Manifest; errors: Diagnostic[] }> {
	const manifest = Object.fromEntries(ROLES.map((r) => [r.role, {}])) as Manifest;
	const errors: Diagnostic[] = [];
	const fail = (code: Diagnostic['code'], path: string, message: string) => errors.push({ code, path, message: `${path}: ${message}` });
	for (const f of files) {
		const abs = join(root, f.path);
		if (f.path.endsWith('.svelte')) manifest[f.role][f.name] = f.path;
		else if (f.path.endsWith('.md')) {
			const text = readFileSync(abs, 'utf8');
			if (f.role === 'skill' && !/^---\n(?:.*\n)*?description:\s*\S.*\n(?:.*\n)*?---/.test(text))
				fail('load/skill-description', f.path, 'a skill starts with frontmatter holding `description:`');
			manifest[f.role][f.name] = text;
		} else {
			let mod: { default?: unknown };
			try {
				mod = await import(pathToFileURL(abs).href);
			} catch (e) {
				fail('load/failed', f.path, e instanceof Error ? e.message : String(e));
				continue;
			}
			if (mod.default === undefined) fail('load/no-default', f.path, `default-export the ${f.role} declaration`);
			else manifest[f.role][f.name] = mod.default;
		}
	}
	errors.push(...manifestErrors(manifest, layer)); // hook:callables — `bolt check` runs the same checks on the isolate-evaluated manifest
	return { manifest, errors };
}

/**
 * The manifest-level checks of a loaded manifest (names against folders, integration direction, listed pages). A workspace
 * may not reach into the built-in layer: `table` is a system model's, and a relationship adds no column to a system table.
 */
export function manifestErrors(manifest: Manifest, layer: 'workspace' | 'system' = 'workspace'): Diagnostic[] {
	const errors: Diagnostic[] = [];
	const fail = (code: Diagnostic['code'], path: string, message: string) => errors.push({ code, path, message: `${path}: ${message}` });
	// A role typed against its own folder takes its name (`collection('<m>', …)`), which must be the folder's.
	for (const [role, dir] of [['collection', 'data/collection'], ['integration', 'data/collection'], ['pipeline', 'data/collection'],
		['app', 'app'], ['group', 'app'], ['kiosk', 'kiosk']] as const) {
		for (const [name, d] of Object.entries(manifest[role] ?? {})) {
			const declared = (d as { name?: unknown }).name;
			if (declared !== name) fail(`load/${role}-name`, `src/${dir}/${name}/+${role}.ts`, `declares ${role}('${String(declared)}'); the folder names it '${name}'`);
		}
	}
	// hook:write — every row carries the system columns; a model field of the same name would shadow one (`revision` is the
	// row version every update checks, rule 25), so it is refused here rather than as a duplicate column at migration
	if (layer === 'workspace') {
		for (const [name, d] of Object.entries(manifest.model)) {
			for (const f of Object.keys((d as { fields?: object } | undefined)?.fields ?? {}))
				if (SYSTEM_COLUMNS.includes(f as never)) fail('load/reserved-field', `src/data/model/${name}/+model.ts`,
					`'${f}' is a system column on every row (${SYSTEM_COLUMNS.join(', ')}); name the field for what it holds, e.g. '${name.replace(/s$/, '')}_${f}'`);
			if ((d as { table?: unknown } | undefined)?.table !== undefined)
				fail('load/system-only', `src/data/model/${name}/+model.ts`, '`table` describes a built-in system table; a workspace model takes the engine columns');
		}
		for (const key of Object.keys((manifest.relationship[''] ?? {}) as object))
			if (Object.hasOwn(SYSTEM.models, key.slice(0, key.indexOf('.'))))
				fail('load/system-owned', 'src/data/+relationship.ts', `'${key}': ${key.slice(0, key.indexOf('.'))} is a built-in system table; a relationship to it is declared on your model`);
	}
	for (const [name, i] of Object.entries(manifest.integration)) {
		const direction = spec(i).direction;
		if (direction !== 'one_way' && direction !== 'two_way') fail('load/integration-direction', `src/data/collection/${name}/+integration.ts`, "direction is 'one_way' or 'two_way'");
	}
	// `app/page-unlisted` (§3.3.1): every page file has an entry in its app's `pages`, whose key order is nav order.
	for (const page of Object.keys(manifest.page ?? {})) {
		const at = page.lastIndexOf('/');
		const app = manifest.app[page.slice(0, at)];
		if (app && !Object.hasOwn(spec(app).pages ?? {}, page.slice(at + 1)))
			fail('app/page-unlisted', String(manifest.page[page]), `app '${page.slice(0, at)}' lists no page '${page.slice(at + 1)}' in pages`);
	}
	// every kiosk page file has an entry in its kiosk's `pages`, whose key order is nav order.
	for (const page of Object.keys(manifest.kiosk_page ?? {})) {
		const at = page.lastIndexOf('/');
		const kiosk = (manifest.kiosk ?? {})[page.slice(0, at)];
		if (kiosk && !Object.hasOwn(spec(kiosk).pages ?? {}, page.slice(at + 1)))
			fail('app/page-unlisted', String(manifest.kiosk_page[page]), `kiosk '${page.slice(0, at)}' lists no page '${page.slice(at + 1)}' in pages`);
	}
	return errors;
}

/** The literal of a `{ name, spec }` declaration (collection, app, group, integration, pipeline), else the export itself. */
export function spec(d: unknown): { direction?: unknown; pages?: object } {
	const o = (d ?? {}) as { spec?: object };
	return (o.spec ?? o) as { direction?: unknown; pages?: object };
}
