/// <reference types="node" />
// Loading (§3.2, rule 2): import each role's default export and gather the manifest, keyed by role then path-derived name.
import { Effect, FileSystem, Path, Predicate, Schema } from 'effect';
import { pathToFileURL } from 'node:url';
import { type Diagnostic, type Discovered, sourcePath } from './discover.ts';
import { ROLES, type Role } from '../decl/layout.ts';
import { SYSTEM_COLUMNS } from '../protocol/catalog.ts'; // hook:write
import { SYSTEM } from '../system/index.ts';
import { DRIVERS, type IntegrationSpec } from '../decl/runtime/integration.ts';
import { pageServerMetadata } from '../decl/runtime/page.ts';

/**
 * `manifest[role][name]`: a `.ts` role's default export (declarations are data), a `.md` role's text, a `.svelte`
 * role's path (the bundler compiles it).
 */
export type Manifest = { [R in Role]: Record<string, unknown> };

// Plain `import()` in the build process, for the compiler tests and the non-code roles; `bolt check` evaluates code roles in
// the isolate instead (rule 2: frozen clock, seeded random, twice, hash compare; check/index.ts).
class LoadError extends Schema.TaggedError<LoadError>()('LoadError', {
	path: Schema.String,
	cause: Schema.Defect()
}) {}

export const load = Effect.fn('bolt.load')(function* (root: string, files: readonly Discovered[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const manifest = Object.fromEntries(ROLES.map((r) => [r.role, {}])) as Manifest;
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
			manifest[f.role][f.name] = text;
		} else {
			const loaded = yield* Effect.tryPromise({
				try: () => import(pathToFileURL(abs).href),
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
			const mod: { default?: unknown } = loaded.success;
			if (mod.default === undefined)
				fail('load/no-default', f.path, `default-export the ${f.role} declaration`);
			else if (f.role === 'page_server' || f.role === 'kiosk_page_server') {
				const codec = yield* Effect.tryPromise({
					try: () =>
						import(
							pathToFileURL(
								path.join(
									path.dirname(abs),
									`${f.name.slice(f.name.lastIndexOf('/') + 1)}.page.data.ts`
								)
							).href
						),
					catch: (cause) => new LoadError({ path: f.path, cause })
				}).pipe(Effect.result);
				if (codec._tag === 'Failure') {
					fail('load/page-server-codec', f.path, String(codec.failure.cause));
					continue;
				}
				const shared: { default?: unknown } = codec.success;
				const metadata = yield* Effect.try({
					try: () => pageServerMetadata(mod.default, shared.default),
					catch: (cause) => new LoadError({ path: f.path, cause })
				}).pipe(Effect.result);
				if (metadata._tag === 'Failure')
					fail('load/page-server-shape', f.path, String(metadata.failure.cause));
				else manifest[f.role][f.name] = metadata.success;
			} else manifest[f.role][f.name] = mod.default;
		}
	}
	return { manifest, errors };
});

/**
 * The manifest-level checks of a loaded manifest (names against folders, integration definitions, listed pages). A workspace
 * may not reach into the built-in layer: `table` is a system model's, and a relationship adds no column to a system table.
 */
export function manifestErrors(
	manifest: Manifest,
	layer: 'workspace' | 'system' = 'workspace'
): Diagnostic[] {
	const errors: Diagnostic[] = [];
	const fail = (code: Diagnostic['code'], path: string, message: string) =>
		errors.push({ code, path, message: `${path}: ${message}` });
	// A role typed against its own folder takes its name (`collection('<m>', …)`), which must be the folder's.
	for (const role of ['collection', 'pipeline', 'app', 'group', 'kiosk'] as const) {
		for (const [name, d] of Object.entries(manifest[role] ?? {})) {
			const declared = (d as { name?: unknown }).name;
			if (declared !== name)
				fail(
					`load/${role}-name`,
					sourcePath(role, name),
					`declares ${role}('${String(declared)}'); the folder names it '${name}'`
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
				const policies = Array.isArray(entry)
					? entry
					: Predicate.isObject(entry)
						? entry['policies']
						: undefined;
				if (
					!handle.trim() ||
					!Array.isArray(policies) ||
					policies.some((policy) => typeof policy !== 'string')
				) {
					fail('load/team-shape', path, `team '${handle}' declares its policy list`);
					continue;
				}
				for (const policy of policies)
					if (!Object.hasOwn(manifest.policy, policy))
						fail('load/team-policy', path, `team '${handle}' names unknown policy '${policy}'`);
				if (Predicate.isObject(entry)) {
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
	errors.push(...integrationErrors(manifest));
	// hook:write — every row carries the system columns; a model field of the same name would shadow one (`revision` is the
	// row version every update checks, rule 25), so it is refused here rather than as a duplicate column at migration
	if (layer === 'workspace') {
		for (const [name, d] of Object.entries(manifest.model)) {
			for (const f of Object.keys((d as { fields?: object } | undefined)?.fields ?? {}))
				if (SYSTEM_COLUMNS.some((column) => column === f))
					fail(
						'load/reserved-field',
						sourcePath('model', name),
						`'${f}' is a system column on every row (${SYSTEM_COLUMNS.join(', ')}); name the field for what it holds, e.g. '${name.replace(/s$/, '')}_${f}'`
					);
			if ((d as { table?: unknown } | undefined)?.table !== undefined)
				fail(
					'load/system-only',
					sourcePath('model', name),
					'`table` describes a built-in system table; a workspace model takes the engine columns'
				);
		}
		for (const key of Object.keys((manifest.relationship[''] ?? {}) as object))
			if (Object.hasOwn(SYSTEM.models, key.slice(0, key.indexOf('.'))))
				fail(
					'load/system-owned',
					sourcePath('relationship', ''),
					`'${key}': ${key.slice(0, key.indexOf('.'))} is a built-in system table; a relationship to it is declared on your model`
				);
	}
	// `app/page-unlisted` (§3.3.1): every page file has an entry in its app's `pages`, whose key order is nav order.
	for (const page of Object.keys(manifest.page ?? {})) {
		const at = page.lastIndexOf('/');
		const app = manifest.app[page.slice(0, at)];
		if (app && !Object.hasOwn((spec(app)['pages'] ?? {}) as object, page.slice(at + 1)))
			fail(
				'app/page-unlisted',
				String(manifest.page[page]),
				`app '${page.slice(0, at)}' lists no page '${page.slice(at + 1)}' in pages`
			);
		const audience = spec(app)['audience'];
		if (
			(audience === 'external' || audience === 'all' || Predicate.isObject(audience)) &&
			manifest.page_server[page] === undefined
		)
			fail(
				'app/page-server-required',
				String(manifest.page[page]),
				'a public or external page declares a read-only +<page>.page.server.ts loader and shared data codec'
			);
	}
	// every kiosk page file has an entry in its kiosk's `pages`, whose key order is nav order.
	for (const page of Object.keys(manifest.kiosk_page ?? {})) {
		const at = page.lastIndexOf('/');
		const kiosk = (manifest.kiosk ?? {})[page.slice(0, at)];
		if (kiosk && !Object.hasOwn((spec(kiosk)['pages'] ?? {}) as object, page.slice(at + 1)))
			fail(
				'app/page-unlisted',
				String(manifest.kiosk_page[page]),
				`kiosk '${page.slice(0, at)}' lists no page '${page.slice(at + 1)}' in pages`
			);
		const auth = spec(kiosk)['auth'];
		if (
			(auth === 'none' || auth === 'external' || auth === 'all') &&
			manifest.kiosk_page_server[page] === undefined
		)
			fail(
				'app/page-server-required',
				String(manifest.kiosk_page[page]),
				'a public or external kiosk page declares a read-only +<page>.page.server.ts loader and shared data codec'
			);
	}
	for (const role of ['page_server', 'kiosk_page_server'] as const)
		for (const [page, declaration] of Object.entries(manifest[role]))
			if (
				!Predicate.isObject(declaration) ||
				declaration['data'] !== true ||
				declaration['load'] !== true
			)
				fail(
					'load/page-server-shape',
					sourcePath(role, page),
					'a page server declares its shared data codec and generator load body'
				);
	return errors;
}

/** The literal of a `{ name, spec }` declaration (collection, app, group, integration, pipeline), else the export itself. */
export function spec(d: unknown): { readonly [key: string]: unknown } {
	const o = (d ?? {}) as { spec?: object };
	return (o.spec ?? o) as { readonly [key: string]: unknown };
}

type Obj = { readonly [key: string]: unknown };
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
/** Whether a definition carries a conversation: its own (a custom chat over http), or its driver's. */
const conversational = (d: IntegrationSpec | undefined): boolean =>
	d !== undefined && (d.conversation !== undefined || 'conversation' in (DRIVERS[d.driver] ?? {}));

/**
 * Integration definitions (`src/integration/<name>/`): the literal names its folder; each feed writes one collection that
 * exposes no create, delete or action and that no other feed writes, keyed by one FK to `sys_integration` pinned to the
 * definition and the feed's `key`; every declared feed, outbound rule, command `run` and custom conversation has its body;
 * a notification goes to the inbox or through a conversation connection.
 */
function integrationErrors(manifest: Manifest): Diagnostic[] {
	const errors: Diagnostic[] = [];
	const fail = (code: Diagnostic['code'], path: string, message: string) =>
		errors.push({ code, path, message: `${path}: ${message}` });
	const definitions: { readonly [name: string]: IntegrationSpec } = {
		...SYSTEM.integrations,
		...Object.fromEntries(
			Object.entries(manifest.integration_definition).map(([name, d]) => [
				name,
				spec(d) as IntegrationSpec
			])
		)
	};
	const relationships = { ...SYSTEM.relationships, ...((manifest.relationship[''] ?? {}) as Obj) };
	const fedBy = new Map<string, string>();
	for (const [name, d] of Object.entries(manifest.integration_definition)) {
		const path = sourcePath('integration_definition', name);
		const declared = Predicate.isObject(d) ? d['name'] : undefined;
		if (declared !== name)
			fail(
				'load/name-mismatch',
				path,
				`declares integration('${String(declared)}'); the folder names it '${name}'`
			);
		const s = definitions[name]!,
			bodies = Predicate.isObject(d) && Predicate.isObject(d['bodies']) ? d['bodies'] : {};
		const attached = (part: string, key: string, body: string) => {
			const of = bodies[part];
			return Predicate.isObject(of) && Predicate.isObject(of[key]) && Boolean(of[key][body]);
		};
		for (const [feed, f] of Object.entries(s.feeds ?? {})) {
			const at = `feed '${feed}'`;
			const pushed = f.from === 'driver' || f.from === 'messages';
			if (!attached('feeds', feed, pushed ? 'map' : 'read'))
				fail(
					'load/missing-body',
					path,
					`${at} has no body: attach ${name}.feed('${feed}', { ${pushed ? 'map' : 'read'} })`
				);
			const c = manifest.collection[f.into];
			if (c === undefined) {
				fail('load/feed-target', path, `${at} writes '${f.into}', which is no collection`);
				continue;
			}
			const exposed = ['create', 'delete', 'actions'].filter((k) => spec(c)[k] !== undefined);
			if (exposed.length > 0)
				fail(
					'load/feed-target',
					path,
					`${at} writes '${f.into}', whose collection exposes ${exposed.join(', ')}: a feed's rows change only through it (local fields through update)`
				);
			const other = fedBy.get(f.into);
			if (other !== undefined)
				fail('load/feed-target', path, `${at} writes '${f.into}', which ${other} already writes`);
			fedBy.set(f.into, `${name}.${feed}`);
			const key = list((manifest.model[f.into] as Obj | undefined)?.['key']).map(String);
			const instance = (field: string) => {
				const r = relationships[`${f.into}.${field}`];
				return Predicate.isObject(r) && r['to'] === 'sys_integration'
					? Predicate.isObject(r['where']) && Predicate.isObject(r['where']['integration'])
						? r['where']['integration']['eq']
						: null
					: undefined;
			};
			const fks = key.filter((field) => instance(field) !== undefined);
			const rest = key.filter((field) => instance(field) === undefined);
			if (
				fks.length !== 1 ||
				instance(fks[0]!) !== name ||
				rest.length !== f.key.length ||
				f.key.some((field) => !rest.includes(field))
			)
				fail(
					'load/feed-key',
					path,
					`${at}: the model key of '${f.into}' is one FK to sys_integration pinned to '${name}' (where: { integration: { eq: '${name}' } }) and the feed's key (${f.key.join(', ')}); it is [${key.join(', ')}]`
				);
		}
		for (const rule of Object.keys(s.outbound ?? {})) {
			if (!attached('outbound', rule, 'build'))
				fail(
					'load/missing-body',
					path,
					`outbound '${rule}' has no body: attach ${name}.outbound('${rule}', { build })`
				);
			else if (!conversational(s) && !attached('outbound', rule, 'run'))
				fail(
					'load/missing-body',
					path,
					`outbound '${rule}' commands through a ${s.driver} instance: its body declares run`
				);
		}
		if (s.conversation !== undefined)
			for (const body of ['receive', 'send'] as const)
				if (!bodies[body])
					fail('load/missing-body', path, `a custom conversation attaches ${name}.${body}(…)`);
	}
	const connections =
		(
			manifest.workspace[''] as
				{ connections?: { readonly [slot: string]: { integration: string } } } | undefined
		)?.connections ?? {};
	for (const [name, c] of Object.entries(manifest.collection))
		for (const rules of Object.values(
			(spec(c)['notifications'] ?? {}) as { readonly [event: string]: readonly Obj[] }
		))
			for (const rule of rules) {
				const channel = rule['channel'];
				if (
					channel !== undefined &&
					channel !== 'inbox' &&
					!conversational(definitions[connections[String(channel)]?.integration ?? ''])
				)
					fail(
						'load/notification-channel',
						sourcePath('collection', name),
						`a notification's channel is 'inbox' or a conversation connection; '${String(channel)}' is not`
					);
			}
	return errors;
}
