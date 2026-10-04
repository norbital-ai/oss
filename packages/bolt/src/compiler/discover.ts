/// <reference types="node" />
// Discovery (§3.1, §3.2, rule 1): names come from paths, never from file contents.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BUILTIN_FIELDS } from '../decl/builtin-fields.ts';
import { SYSTEM } from '../system/index.ts';

/** The file roles of §3.2. `dir` is under `src/`: `*` is one name segment, `**` one or more (app paths); `*` in `file` is the name. */
export const ROLES = [
	{ role: 'workspace', dir: '', file: '+workspace.ts' },
	{ role: 'relationship', dir: 'data', file: '+relationship.ts' },
	{ role: 'model', dir: 'data/model/**', file: '+model.ts' },
	{ role: 'custom_field', dir: 'data/custom_field/*', file: '+definition.ts' },
	{ role: 'renderer', dir: 'data/custom_field/*', file: '+renderer.svelte' },
	{ role: 'collection', dir: 'data/collection/**', file: '+collection.ts' },
	{ role: 'representation', dir: 'data/collection/**', file: '+representation.svelte' },
	{ role: 'integration', dir: 'data/collection/**', file: '+integration.ts' },
	{ role: 'pipeline', dir: 'data/collection/**', file: '+pipeline.ts' },
	{ role: 'policy', dir: 'access', file: '+*.policy.ts' },
	{ role: 'team', dir: 'access', file: '+team.ts' },
	{ role: 'agent', dir: 'agent', file: '+agent.md' },
	{ role: 'agent_external', dir: 'agent', file: '+agent.external.md' },
	{ role: 'skill', dir: 'agent/skill', file: '+*.skill.md' },
	{ role: 'mcp', dir: 'agent/mcp', file: '+*.mcp.ts' },
	{ role: 'automation', dir: 'automation', file: '+*.automation.ts' },
	{ role: 'channel', dir: 'custom_channels/*', file: '+channel.ts' },
	{ role: 'connect', dir: 'custom_channels/*', file: '+channel.configuration.svelte' },
	{ role: 'connection', dir: 'connection', file: '+*.connection.ts' },
	{ role: 'app', dir: 'app/**', file: '+app.ts' },
	{ role: 'session', dir: 'app/**', file: '+session.svelte' },
	{ role: 'page', dir: 'app/**', file: '+*.page.svelte' },
	{ role: 'messages', dir: 'i18n', file: '+messages.ts' },
	{ role: 'locale', dir: 'i18n', file: '+*.messages.ts' },
	{ role: 'group', dir: 'app/**', file: '+group.ts' },
] as const;
export type Role = (typeof ROLES)[number]['role'];

/**
 * A discovered role file. `name` is the path-derived name: the folder's (`orders`, `hr/kiosk`) or the file's
 * (`sales_rep`); a page is `<app>/<page>`; singletons (`workspace`, `relationship`, …) have `''`.
 */
export type Discovered = { role: Role; name: string; path: string };
export type Diagnostic = { code: `${'discover' | 'load' | 'app'}/${string}`; path: string; message: string; help?: string };

const NAME = /^[a-z][a-z0-9_]*$/;
/** Names the built-in layer (`src/system/**`) takes, besides the `sys_*` and `bolt_*` prefixes. */
const reserved = (name: string): boolean => /^(sys_|bolt_)/.test(name) || Object.hasOwn(SYSTEM.models, name);

/** The help text of every layout error prints the §3.2 table. */
export const LAYOUT_HELP = `A + file is a compiler role; files without + are ordinary modules and may sit anywhere.
If the folder names the thing the file is +<role>.<ext>, otherwise +<name>.<role>.<ext>. Folder names are singular;
names match ${NAME.source}. The roles:
${ROLES.map((r) => `  src/${r.dir.replaceAll('**', '<app>').replaceAll('*', '<name>')}${r.dir ? '/' : ''}${r.file.replace('*', '<name>')}`).join('\n')}`;

const escape = (s: string) => s.replace(/[.+]/g, '\\$&');
const fileRe = (file: string) => new RegExp(`^${escape(file).replace('*', '([^.]+)')}$`);
const FOLDERS = new Set(ROLES.flatMap((r) => r.dir.split('/')).filter((s) => s !== '' && !s.includes('*')));

/** Matches a dir pattern; returns the folder name (`''` when the pattern has none) or undefined. */
function matchDir(pattern: string, segs: string[]): string | undefined {
	const p = pattern === '' ? [] : pattern.split('/');
	if (p.at(-1) === '**') {
		const fixed = p.slice(0, -1);
		return segs.length > fixed.length && fixed.every((s, i) => s === segs[i]) ? segs.slice(fixed.length).join('/') : undefined;
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
export function discover(root: string, layer: 'workspace' | 'system' = 'workspace'): { files: Discovered[]; errors: Diagnostic[] } {
	const files: Discovered[] = [];
	const errors: Diagnostic[] = [];
	const fail = (code: string, path: string, message: string) =>
		errors.push({ code: `discover/${code}`, path, message: `${path}: ${message}`, help: LAYOUT_HELP });
	const system = layer === 'system';
	const src = system ? join(root, 'src', 'system') : join(root, 'src');
	const walk = (dir: string) => existsSync(dir)
		? readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && !relative(root, join(d.parentPath, d.name)).split(sep).some((s) => s.startsWith('.') || s === 'node_modules'))
			.map((d) => relative(root, join(d.parentPath, d.name)).split(sep).join('/'))
			.sort()
		: [];

	for (const path of walk(src)) {
		const segs = path.split('/').slice(system ? 2 : 1);
		const base = segs.pop()!;
		if (!base.startsWith('+')) continue;
		const byFile = ROLES.map((r) => ({ r, m: fileRe(r.file).exec(base) })).filter((x) => x.m !== null);
		if (byFile.length === 0) {
			const own = ROLES.find((r) => !r.file.includes('*') && base.endsWith(`.${r.file.slice(1)}`));
			if (own) fail('one-per-folder', path, `the folder names the thing, so it holds at most one ${own.file} (write it as ${own.file})`);
			else fail('unknown-role', path, `${base} is no compiler role (drop the + for an ordinary module)`);
			continue;
		}
		const hit = byFile.map(({ r, m }) => ({ r, fileName: m![1], folder: matchDir(r.dir, segs) })).find((x) => x.folder !== undefined);
		if (!hit) {
			const plural = segs.find((s) => s.endsWith('s') && FOLDERS.has(s.slice(0, -1)));
			const where = byFile.map(({ r }) => `src/${r.dir.replaceAll('**', '<app>').replaceAll('*', '<name>')}`).join(' or ');
			if (plural) fail('plural-folder', path, `folder names are singular: '${plural}' is '${plural.slice(0, -1)}'; ${base} belongs in ${where}`);
			else fail('wrong-folder', path, `${base} belongs in ${where}`);
			continue;
		}
		const { r, fileName, folder } = hit;
		const bad = [...folder!.split('/'), fileName].find((s) => s !== undefined && s !== '' && !NAME.test(s));
		if (bad !== undefined) {
			fail('bad-name', path, `'${bad}' is not a name (${NAME.source})`);
			continue;
		}
		const nested =
			r.role === 'model' ||
			r.role === 'collection' ||
			r.role === 'representation' ||
			r.role === 'integration' ||
			r.role === 'pipeline';
		const leaf = folder!.split('/').at(-1)!;
		const name = r.role === 'page' ? `${folder}/${fileName}` : nested ? (fileName ?? leaf) : (fileName ?? folder!);
		files.push({ role: r.role, name, path });
	}

	// Folder-level rules of §3.2.
	const has = (role: Role, name: string) => files.some((f) => f.role === role && f.name === name);
	const of = (role: Role) => files.filter((f) => f.role === role);
	if (!system && !has('workspace', '')) fail('workspace-missing', 'src/+workspace.ts', 'a workspace has exactly one src/+workspace.ts');
	for (const f of files) {
		if (f.role === 'collection' && !has('model', f.name)) fail('collection-without-model', f.path, `no src/data/model/${f.name}/+model.ts; a collection exposes the model of its name`);
		if ((f.role === 'representation' || f.role === 'integration' || f.role === 'pipeline') && !has('collection', f.name))
			fail('without-collection', f.path, `no src/data/collection/${f.name}/+collection.ts beside it`);
		if (f.role === 'renderer' && !has('custom_field', f.name)) fail('custom-field-without-definition', f.path, `no +definition.ts beside it`);
		if (f.role === 'connect' && !has('channel', f.name)) fail('connect-without-channel', f.path, `no +channel.ts beside this configuration component`);
		if (f.role === 'session' && !has('app', f.name)) fail('session-without-app', f.path, 'a session sits in a folder with +app.ts');
		if (f.role === 'page' && !has('app', f.name.slice(0, f.name.lastIndexOf('/')))) fail('page-without-app', f.path, 'a page sits in a folder with +app.ts');
		if ((f.role === 'app' || f.role === 'group') && has(f.role === 'app' ? 'group' : 'app', f.name))
			fail('app-and-group', f.path, 'a folder holds +app.ts or +group.ts, never both');
		if (f.role === 'app' || f.role === 'group') {
			const parts = f.name.split('/');
			const outer = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')).find((p) => !has('group', p));
			if (outer !== undefined) fail('app-nesting', f.path, `src/app/${outer}/ holds no +group.ts; only a group holds apps and groups`);
		}
		if (!system && (f.role === 'model' || f.role === 'collection') && reserved(f.name))
			fail('reserved-name', f.path, `'${f.name}' is the built-in layer's (sys_*, bolt_* and ${Object.keys(SYSTEM.models).filter((n) => !/^(sys_|bolt_)/.test(n)).join(', ')} are reserved)`);
		// a built-in custom field's name is taken: `{ kind: 'custom', of }` names one namespace
		if (f.role === 'custom_field' && Object.hasOwn(BUILTIN_FIELDS, f.name)) fail('reserved-name', f.path, `'${f.name}' is a built-in custom field (${Object.keys(BUILTIN_FIELDS).join(', ')})`);
		if (f.role === 'channel' && f.name === 'inbox') fail('reserved-name', f.path, `'inbox' is the inbox transport's name`);
		if (f.role === 'locale' && !has('messages', '')) fail('messages-missing', f.path, 'src/i18n/ holds exactly one +messages.ts, the base locale');
	}
	// X-1: collection, automation, channel and connection names are unique across roles.
	const spaced = ['collection', 'automation', 'channel', 'connection'] as const;
	const seen = new Map<string, Discovered>();
	for (const f of files.filter((x) => spaced.includes(x.role as (typeof spaced)[number]))
		.sort((a, b) => spaced.indexOf(a.role as (typeof spaced)[number]) - spaced.indexOf(b.role as (typeof spaced)[number]))) {
		const first = seen.get(f.name);
		if (first) fail('name-clash', f.path, `'${f.name}' is already the ${first.role} ${first.path}`);
		else seen.set(f.name, f);
	}

	// Seeds: seed/**/<collection>.json[.gz]; seed/assets.json, seed/assets/** and seed/seed.ts are not collections.
	const collections = new Set([...of('collection').map((f) => f.name), ...Object.keys(SYSTEM.collections)]);
	if (!system) for (const path of walk(join(root, 'seed'))) {
		const m = /^seed\/(?:.+\/)?([^/]+)\.json(?:\.gz)?$/.exec(path);
		if (!m || path === 'seed/assets.json' || path.startsWith('seed/assets/')) continue;
		if (!collections.has(m[1]!)) fail('seed-unknown-collection', path, `'${m[1]}' names no collection`);
	}
	return { files, errors };
}
