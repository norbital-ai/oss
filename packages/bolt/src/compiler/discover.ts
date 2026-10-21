/// <reference types="node" />
// Discovery (§3.1, §3.2, rule 1): names come from paths, never from file contents.
import { Effect, FileSystem, Path } from 'effect';
import { join, relative, sep } from 'node:path';
import { BUILTIN_FIELDS } from '../decl/builtin-fields.ts';
import { SYSTEM } from '../system/index.ts';
import { LAYOUT_HELP, NAME, ROLES, type Role } from '../decl/layout.ts';

/**
 * A discovered role file. `name` is the path-derived name: the folder's (`orders`, `hr/kiosk`) or the file's
 * (`sales_rep`); a page is `<app>/<page>`; singletons (`workspace`, `relationship`, …) have `''`.
 */
export type Discovered = { role: Role; name: string; path: string };
export type Diagnostic = {
	code: `${'discover' | 'load' | 'app'}/${string}`;
	path: string;
	message: string;
	help?: string;
};

/** Names the built-in layer (`src/system/**`) takes, besides the `sys_*` and `bolt_*` prefixes. */
const reserved = (name: string): boolean =>
	/^(sys_|bolt_)/.test(name) || Object.hasOwn(SYSTEM.models, name);

const escape = (s: string) => s.replace(/[.+]/g, '\\$&');
const fileRe = (file: string) => new RegExp(`^${escape(file).replace('*', '([^.]+)')}$`);
const FOLDERS = new Set(
	ROLES.flatMap((r) => r.dir.split('/')).filter((s) => s !== '' && !s.includes('*'))
);

/** Matches a dir pattern; returns the folder name (`''` when the pattern has none) or undefined. */
function matchDir(pattern: string, segs: string[]): string | undefined {
	const p = pattern === '' ? [] : pattern.split('/');
	if (p.at(-1) === '**') {
		const fixed = p.slice(0, -1);
		return segs.length > fixed.length && fixed.every((s, i) => s === segs[i])
			? segs.slice(fixed.length).join('/')
			: undefined;
	}
	if (p.length !== segs.length) return undefined;
	let name = '';
	for (const [i, s] of p.entries()) {
		if (s === '*') name = segs[i]!;
		else if (s !== segs[i]) return undefined;
	}
	return name;
}

/**
 * Walks `<root>/src` (and `<root>/seed` for seed names) and classifies every `+` file; every layout mistake is a diagnostic.
 * `system`: bolt's own built-in layer, laid out as a workspace's `src/` under `<root>/src/system` (no `+workspace.ts`, no seeds).
 */
export const discover = Effect.fn('bolt.discover')(function* (
	root: string,
	layer: 'workspace' | 'system' = 'workspace'
) {
	const fs = yield* FileSystem.FileSystem;
	const pathService = yield* Path.Path;
	const files: Discovered[] = [];
	const errors: Diagnostic[] = [];
	const fail = (code: string, path: string, message: string) =>
		errors.push({
			code: `discover/${code}`,
			path,
			message: `${path}: ${message}`,
			help: LAYOUT_HELP
		});
	const system = layer === 'system';
	const src = system ? join(root, 'src', 'system') : join(root, 'src');
	const walk = Effect.fnUntraced(function* (dir: string) {
		if (!(yield* fs.exists(dir))) return [];
		const entries = yield* fs.readDirectory(dir, { recursive: true });
		const files: string[] = [];
		for (const entry of entries) {
			const absolute = pathService.join(dir, entry);
			const relative = pathService.relative(root, absolute).split(pathService.sep).join('/');
			if (relative.split('/').some((s) => s.startsWith('.') || s === 'node_modules')) continue;
			if ((yield* fs.stat(absolute)).type === 'File') files.push(relative);
		}
		return files.sort();
	});

	const paths = yield* walk(src);
	for (const path of paths) {
		const segs = path.split('/').slice(system ? 2 : 1);
		const base = segs.pop()!;
		if (!base.startsWith('+')) continue;
		const byFile = ROLES.map((r) => ({ r, m: fileRe(r.file).exec(base) })).filter(
			(x) => x.m !== null
		);
		if (byFile.length === 0) {
			const own = ROLES.find((r) => !r.file.includes('*') && base.endsWith(`.${r.file.slice(1)}`));
			if (own)
				fail(
					'one-per-folder',
					path,
					`the folder names the thing, so it holds at most one ${own.file} (write it as ${own.file})`
				);
			else
				fail(
					'unknown-role',
					path,
					`${base} is no compiler role (drop the + for an ordinary module)`
				);
			continue;
		}
		const hit = byFile
			.map(({ r, m }) => ({ r, fileName: m![1], folder: matchDir(r.dir, segs) }))
			.find((x) => x.folder !== undefined);
		if (!hit) {
			const plural = segs.find((s) => s.endsWith('s') && FOLDERS.has(s.slice(0, -1)));
			const where = byFile
				.map(({ r }) => `src/${r.dir.replaceAll('**', '<app>').replaceAll('*', '<name>')}`)
				.join(' or ');
			if (plural)
				fail(
					'plural-folder',
					path,
					`folder names are singular: '${plural}' is '${plural.slice(0, -1)}'; ${base} belongs in ${where}`
				);
			else fail('wrong-folder', path, `${base} belongs in ${where}`);
			continue;
		}
		const { r, fileName, folder } = hit;
		const bad = [...folder!.split('/'), fileName].find(
			(s) => s !== undefined && s !== '' && !NAME.test(s)
		);
		if (bad !== undefined) {
			fail('bad-name', path, `'${bad}' is not a name (${NAME.source})`);
			continue;
		}
		const nested =
			r.role === 'model' ||
			r.role === 'collection' ||
			r.role === 'representation' ||
			r.role === 'pipeline';
		const leaf = folder!.split('/').at(-1)!;
		const name =
			r.role === 'page' ||
			r.role === 'page_server' ||
			r.role === 'kiosk_page' ||
			r.role === 'kiosk_page_server'
				? `${folder}/${fileName}`
				: nested
					? (fileName ?? leaf)
					: (fileName ?? folder!);
		files.push({ role: r.role, name, path });
	}

	// A source declaration has one owner.
	const declarations = new Map<string, Discovered>();
	for (const file of files.filter((file) => file.role === 'model' || file.role === 'policy')) {
		const identity = `${file.role}:${file.name}`;
		const previous = declarations.get(identity);
		if (previous !== undefined)
			fail(
				'duplicate-declaration',
				file.path,
				`'${file.name}' is already declared by ${previous.path}`
			);
		else declarations.set(identity, file);
	}
	// Folder-level rules of §3.2.
	const has = (role: Role, name: string) => files.some((f) => f.role === role && f.name === name);
	const of = (role: Role) => files.filter((f) => f.role === role);
	if (!system && !has('workspace', ''))
		fail('workspace-missing', 'src/+workspace.ts', 'a workspace has exactly one src/+workspace.ts');
	for (const f of files) {
		if (f.role === 'collection' && !has('model', f.name))
			fail(
				'collection-without-model',
				f.path,
				`no src/data/model/+${f.name}.model.ts; a collection exposes the model of its name`
			);
		if ((f.role === 'representation' || f.role === 'pipeline') && !has('collection', f.name))
			fail(
				'without-collection',
				f.path,
				`no src/data/collection/${f.name}/+collection.ts beside it`
			);
		if (f.role === 'renderer' && !has('custom_field', f.name))
			fail('custom-field-without-definition', f.path, `no +definition.ts beside it`);
		if (f.role === 'integration_setup' && !has('integration_definition', f.name))
			fail('setup-without-integration', f.path, 'no +integration.ts beside this setup component');
		if (f.role === 'session' && !has('app', f.name))
			fail('session-without-app', f.path, 'a session sits in a folder with +app.ts');
		if (f.role === 'page' && !has('app', f.name.slice(0, f.name.lastIndexOf('/'))))
			fail('page-without-app', f.path, 'a page sits in a folder with +app.ts');
		if (f.role === 'kiosk_page' && !has('kiosk', f.name.slice(0, f.name.lastIndexOf('/'))))
			fail('kiosk-page-without-kiosk', f.path, 'a kiosk page sits in a folder with +kiosk.ts');
		if (f.role === 'page_server' || f.role === 'kiosk_page_server') {
			const pageRole = f.role === 'page_server' ? 'page' : 'kiosk_page';
			if (!has(pageRole, f.name))
				fail('server-without-page', f.path, 'a server loader sits beside its +<page>.page.svelte');
			const data = f.path.replace(/\+([^/]+)\.page\.server\.ts$/, '$1.page.data.ts');
			if (!paths.includes(data))
				fail(
					'page-data-missing',
					f.path,
					`share its default data codec through the ordinary helper ${data}`
				);
		}
		if (f.role === 'kiosk' && f.name.includes('/'))
			fail(
				'kiosk-nesting',
				f.path,
				'a kiosk is top-level: src/kiosk/<name>/ holds +kiosk.ts, never a nested path'
			);
		if ((f.role === 'app' || f.role === 'group') && has(f.role === 'app' ? 'group' : 'app', f.name))
			fail('app-and-group', f.path, 'a folder holds +app.ts or +group.ts, never both');
		if (f.role === 'app' || f.role === 'group') {
			const parts = f.name.split('/');
			const outer = parts
				.slice(0, -1)
				.map((_, i) => parts.slice(0, i + 1).join('/'))
				.find((p) => !has('group', p));
			if (outer !== undefined)
				fail(
					'app-nesting',
					f.path,
					`src/app/${outer}/ holds no +group.ts; only a group holds apps and groups`
				);
		}
		if (!system && (f.role === 'model' || f.role === 'collection') && reserved(f.name))
			fail(
				'reserved-name',
				f.path,
				`'${f.name}' is the built-in layer's (sys_*, bolt_* and ${Object.keys(SYSTEM.models)
					.filter((n) => !/^(sys_|bolt_)/.test(n))
					.join(', ')} are reserved)`
			);
		// bolt's conversation definitions are system definitions; `inbox` is the in-app notice channel
		if (
			!system &&
			f.role === 'integration_definition' &&
			(Object.hasOwn(SYSTEM.integrations, f.name) || f.name === 'inbox')
		)
			fail(
				'reserved-name',
				f.path,
				`'${f.name}' is a built-in integration (${[...Object.keys(SYSTEM.integrations), 'inbox'].join(', ')} are reserved)`
			);
		// a built-in custom field's name is taken: `{ kind: 'custom', of }` names one namespace
		if (f.role === 'custom_field' && Object.hasOwn(BUILTIN_FIELDS, f.name))
			fail(
				'reserved-name',
				f.path,
				`'${f.name}' is a built-in custom field (${Object.keys(BUILTIN_FIELDS).join(', ')})`
			);
		if (f.role === 'locale' && !has('messages', ''))
			fail('messages-missing', f.path, 'src/i18n/ holds exactly one +messages.ts, the base locale');
	}
	// Collections, automations and named integrations share one source namespace.
	const spaced = ['collection', 'automation', 'integration_definition'] as const;
	const seen = new Map<string, Discovered>();
	for (const f of files
		.filter((x) => spaced.includes(x.role as (typeof spaced)[number]))
		.sort(
			(a, b) =>
				spaced.indexOf(a.role as (typeof spaced)[number]) -
				spaced.indexOf(b.role as (typeof spaced)[number])
		)) {
		const first = seen.get(f.name);
		if (first) fail('name-clash', f.path, `'${f.name}' is already the ${first.role} ${first.path}`);
		else seen.set(f.name, f);
	}

	// Seeds: seed/**/<collection>.json[.gz]; seed/assets.json, seed/assets/** and seed/seed.ts are not collections.
	const collections = new Set([
		...of('collection').map((f) => f.name),
		...Object.keys(SYSTEM.collections)
	]);
	if (!system)
		for (const path of yield* walk(join(root, 'seed'))) {
			const m = /^seed\/(?:.+\/)?([^/]+)\.json(?:\.gz)?$/.exec(path);
			if (!m || path === 'seed/assets.json' || path.startsWith('seed/assets/')) continue;
			if (!collections.has(m[1]!))
				fail('seed-unknown-collection', path, `'${m[1]}' names no collection`);
		}
	return { files, errors };
});

/** Canonical compiler role path derived from the role table. */
export function sourcePath(role: Role, name: string): string {
	const entry = ROLES.find((entry) => entry.role === role);
	if (entry === undefined) throw new Error(`unknown compiler role ${role}`);
	const page =
		role === 'page' ||
		role === 'page_server' ||
		role === 'kiosk_page' ||
		role === 'kiosk_page_server';
	const at = name.lastIndexOf('/');
	const folder = page ? name.slice(0, at) : name;
	const leaf = page ? name.slice(at + 1) : name;
	const dir = entry.dir.replace('**', folder).replace('*', folder);
	return ['src', dir, entry.file.replace('*', leaf)].filter(Boolean).join('/');
}
