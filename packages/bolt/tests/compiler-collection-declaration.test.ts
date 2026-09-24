import {
	cp,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, text } from '../src/authoring/models-schema.js';
import {
	collectionCatalogEntry,
	compileCollectionWrite,
	compileWorkspaceAuthoring
} from '../src/authoring/model-introspection.js';
import { generateWorkspaceMigration } from '../src/compiler/schema-migrations.js';
import {
	discoverAuthoredSource,
	syncWorkspace,
	systemCollectionCatalog
} from '../src/compiler/workspace-build.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = dirname(packageRoot);
const roots: Array<string> = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const modelSource = [
	"import { defineModel, text } from '@norbital-ai/bolt/authoring';",
	'',
	"export default defineModel({ subject: text().notNull() }, { recordLabel: 'subject' });",
	''
].join('\n');

const collectionSource = [
	"import { defineCollection } from '@norbital-ai/bolt/authoring';",
	"import model from './+model.js';",
	'',
	'export default defineCollection({',
	'\tmodel,',
	'\tcreate: { input: { columns: { subject: true } } },',
	'\tupdate: { input: { columns: { subject: true } } },',
	"\tnotifications: { committed: [{ channel: 'inbox', recipients: () => [], message: () => ({ title: 'Saved', body: 'Saved.' }) }] }",
	'});',
	''
].join('\n');

/** A workspace tree with the two files every workspace must have and the declaration under test. */
const workspaceRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-collection-'));
	roots.push(root);
	const directory = join(root, 'src', 'collections', 'tickets');
	await mkdir(directory, { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'desk', version: '1.0.0' }));
	await writeFile(join(directory, '+model.ts'), modelSource);
	await writeFile(join(root, 'src', '+agents.md'), '# The desk\n\nAnswer from tickets.\n');
	return root;
};

describe('+collection.ts discovery and projection', () => {
	it('discovers and returns the collection declaration instead of reporting it as stray', async () => {
		const root = await workspaceRoot();
		await writeFile(
			join(root, 'src', 'collections', 'tickets', '+collection.ts'),
			collectionSource
		);
		const discovered = await Effect.runPromise(discoverAuthoredSource(root));
		expect(discovered.collectionFiles).toEqual([
			join(root, 'src', 'collections', 'tickets', '+collection.ts')
		]);
	});

	it('refuses a +hooks.ts as a file the compiler has no rule for', async () => {
		const root = await workspaceRoot();
		await writeFile(
			join(root, 'src', 'collections', 'tickets', '+collection.ts'),
			collectionSource
		);
		await writeFile(
			join(root, 'src', 'collections', 'tickets', '+hooks.ts'),
			'export default { mutate: {} };'
		);
		await expect(Effect.runPromise(discoverAuthoredSource(root))).rejects.toThrow(
			/has no rule for:\n {2}- src\/collections\/tickets\/\+hooks\.ts/
		);
	});

	it('projects create, update, notifications and transform presence', () => {
		const write = compileCollectionWrite({
			model: { __kind: 'model', columns: { subject: {} } },
			create: { input: { columns: { subject: true } } },
			update: { input: { columns: { subject: true } } },
			transform: () => [],
			notifications: {
				committed: [{ channel: 'inbox' }, { channel: 'email' }],
				rejected: [{ channel: 'inbox' }]
			}
		});
		expect(write).toEqual({
			create: { columns: { subject: true } },
			update: { columns: { subject: true } },
			notifications: { committed: ['inbox', 'email'], rejected: ['inbox'] },
			hasTransform: true
		});
	});

	it('projects a delete-only declaration as the delete flag and nothing else', () => {
		expect(compileCollectionWrite({ model: { __kind: 'model', columns: {} }, delete: {} })).toEqual(
			{ delete: true, hasTransform: false }
		);
	});

	it('carries a with selection through unchanged', () => {
		const input = {
			columns: { subject: true },
			with: { replies: { create: { columns: { body: true } }, delete: {} } }
		};
		expect(
			compileCollectionWrite({ model: { __kind: 'model', columns: {} }, create: { input } })
		).toEqual({ create: input, hasTransform: false });
	});

	it('drops a notification rule that names no channel and keeps the order of the rest', () => {
		const write = compileCollectionWrite({
			model: { __kind: 'model', columns: {} },
			notifications: { committed: [{ channel: 'email' }, {}, { channel: 'inbox' }] }
		});
		expect(write.notifications).toEqual({ committed: ['email', 'inbox'] });
	});

	it('refuses a declaration that is not a defineCollection() value', () => {
		expect(() => compileCollectionWrite(undefined)).toThrow(
			/default-export a defineCollection\(\)/
		);
		expect(() => compileCollectionWrite('collection')).toThrow(/defineCollection\(\)/);
		expect(() => compileCollectionWrite({ create: { input: {} } })).toThrow(
			/name the model it writes/
		);
		expect(() =>
			compileCollectionWrite({ model: { __kind: 'model', columns: {} }, notifications: [] })
		).toThrow(/notifications must be an object/);
		expect(() =>
			compileCollectionWrite({
				model: { __kind: 'model', columns: {} },
				notifications: { committed: { channel: 'inbox' } }
			})
		).toThrow(/notifications\.committed must be an array/);
	});

	it('projects the write onto the catalog entry as the browser selection', () => {
		const compiled = compileWorkspaceAuthoring({
			models: { tickets: defineModel({ subject: text().notNull(), body: text() }) },
			sourcePaths: { tickets: 'src/collections/tickets/+model.ts' },
			writes: {
				tickets: {
					create: { columns: { subject: true } },
					delete: true,
					notifications: { committed: ['inbox'] },
					hasTransform: true
				}
			}
		});
		const [tickets] = compiled.collections;
		expect(tickets?.write).toEqual({
			create: { columns: { subject: true } },
			delete: true,
			notifications: { committed: ['inbox'] },
			hasTransform: true
		});
		expect(collectionCatalogEntry(tickets!, []).write).toEqual({
			create: { columns: { subject: true } },
			delete: true
		});
		expect(collectionCatalogEntry(tickets!, [])).not.toHaveProperty('inputColumns');
	});

	it('leaves a collection with no declaration without a write on the catalog', () => {
		const compiled = compileWorkspaceAuthoring({
			models: { tickets: defineModel({ subject: text().notNull() }) },
			sourcePaths: { tickets: 'src/collections/tickets/+model.ts' }
		});
		expect(collectionCatalogEntry(compiled.collections[0]!, [])).not.toHaveProperty('write');
	});

	it('gives bolt_notifications an update selection of read alone', () => {
		const notifications = systemCollectionCatalog().find(
			(entry) => entry.name === 'bolt_notifications'
		);
		expect(notifications?.write).toEqual({ update: { columns: { read: true } } });
	});

	it('refuses a +collection.ts whose directory has no +model.ts', async () => {
		const root = await workspaceRoot();
		const orphan = join(root, 'src', 'collections', 'orphans');
		await mkdir(orphan, { recursive: true });
		await writeFile(join(orphan, '+collection.ts'), collectionSource);
		await expect(Effect.runPromise(discoverAuthoredSource(root))).rejects.toThrow(
			/a collection declaration with no model:[\s\S]*src\/collections\/orphans\/\+collection\.ts/
		);
	});

	it('refuses a declared selection naming a column the model lacks, and admits a subset', () => {
		const compile = () =>
			compileWorkspaceAuthoring({
				models: {
					tickets: defineModel({ subject: text().notNull() })
				},
				sourcePaths: { tickets: 'src/collections/tickets/+model.ts' },
				writes: {
					tickets: {
						create: { columns: { title: true } },
						hasTransform: false
					}
				}
			});
		expect(compile).toThrow(
			/Collection tickets\.create\.input\.columns names title, which \+model\.ts does not declare \(its columns are subject\)/
		);
		expect(() =>
			compileWorkspaceAuthoring({
				models: { tickets: defineModel({ subject: text().notNull(), body: text() }) },
				sourcePaths: { tickets: 'src/collections/tickets/+model.ts' },
				writes: { tickets: { update: { columns: { body: true } }, hasTransform: false } }
			})
		).not.toThrow();
	});

	it('refuses a declaration whose model is absent', () => {
		expect(() =>
			compileWorkspaceAuthoring({
				models: { tickets: defineModel({ subject: text().notNull() }) },
				sourcePaths: { tickets: 'src/collections/tickets/+model.ts' },
				writes: { replies: { delete: true, hasTransform: false } }
			})
		).toThrow(/Collection replies declares src\/collections\/replies\/\+collection\.ts but no/);
	});
});

/**
 * The end-to-end half: a real tree, a real Vite build, and the generated files a consumer reads.
 *
 * The scratch workspace carries a materialized `@norbital-ai/bolt` exactly as a consumer sees it —
 * the same shape `compiler-server-artifact-build.test.ts` established — because both the sync
 * process and the two Vite builds resolve the authored modules through the workspace's own
 * `node_modules`, not through this checkout.
 */
const materializeInstalledDependencies = async (source: string, target: string): Promise<void> => {
	await mkdir(target, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.name === '@norbital-ai') continue;
		const sourceEntry = join(source, entry.name);
		const targetEntry = join(target, entry.name);
		if (!entry.name.startsWith('@')) {
			await symlink(await realpath(sourceEntry), targetEntry, 'dir');
			continue;
		}
		await mkdir(targetEntry, { recursive: true });
		for (const child of await readdir(sourceEntry))
			await symlink(await realpath(join(sourceEntry, child)), join(targetEntry, child), 'dir');
	}
};

const materializeBuiltPackage = async (scope: string, name: string): Promise<void> => {
	const source = join(packagesRoot, name);
	const target = join(scope, name);
	await mkdir(target, { recursive: true });
	await Promise.all([
		cp(join(source, 'build'), join(target, 'build'), { recursive: true }),
		copyFile(join(source, 'package.json'), join(target, 'package.json'))
	]);
	await materializeInstalledDependencies(
		join(source, 'node_modules'),
		join(target, 'node_modules')
	);
};

describe('collection declaration in a synced workspace', () => {
	it('attaches the write contract to the artifact, the catalog and the generated declarations', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bolt-collection-sync-'));
		roots.push(root);
		const directory = join(root, 'src', 'collections', 'tickets');
		const packageScope = join(root, 'node_modules', '@norbital-ai');
		await Promise.all([
			mkdir(directory, { recursive: true }),
			mkdir(packageScope, { recursive: true })
		]);
		await Promise.all(
			['bolt', 'bolt-protocol', 'std', 'ui'].map((name) =>
				materializeBuiltPackage(packageScope, name)
			)
		);
		await materializeInstalledDependencies(
			join(packagesRoot, 'bolt', 'node_modules'),
			join(root, 'node_modules')
		);
		await Promise.all([
			mkdir(join(packageScope, 'ui', 'src'), { recursive: true }),
			cp(join(packagesRoot, 'ui', 'assets'), join(packageScope, 'ui', 'assets'), {
				recursive: true
			})
		]);
		await copyFile(
			join(packagesRoot, 'ui', 'src', 'base.css'),
			join(packageScope, 'ui', 'src', 'base.css')
		);
		await Promise.all([
			writeFile(
				join(root, 'package.json'),
				`${JSON.stringify(
					{ name: '@template/collection-sync', version: '0.0.1', private: true, type: 'module' },
					null,
					'\t'
				)}\n`
			),
			writeFile(
				join(root, 'vite.config.ts'),
				[
					"import { defineConfig } from 'vite';",
					"import { boltPlugin } from '@norbital-ai/bolt/vite';",
					'',
					'export default defineConfig({ plugins: [boltPlugin()] });',
					''
				].join('\n')
			),
			writeFile(join(directory, '+model.ts'), modelSource),
			writeFile(join(directory, '+collection.ts'), collectionSource),
			writeFile(join(root, 'src', '+agents.md'), '# Fixture desk\n\nAnswer about tickets.\n')
		]);

		await Effect.runPromise(generateWorkspaceMigration(root, 'baseline'));
		const result = await Effect.runPromise(syncWorkspace(root));

		const catalog = await readFile(join(root, '.norbital', 'generated', 'collections.js'), 'utf8');
		expect(catalog).toContain(
			'"write":{"create":{"columns":{"subject":true}},"update":{"columns":{"subject":true}}}'
		);
		expect(catalog).not.toContain('inputColumns');

		const artifact = await readFile(result.artifactPath, 'utf8');
		for (const fragment of [
			'"write": {',
			'"create": { "columns": { "subject": true } }',
			'"update": { "columns": { "subject": true } }',
			'"notifications": { "committed": ["inbox"] }',
			'"hasTransform": false',
			'"collectionSourcePaths": { "tickets": "src/collections/tickets/+collection.ts" }'
		]) {
			expect(artifact).toContain(fragment);
		}
		expect(artifact).toContain('collections: { "tickets": _collection_default }');
		expect(artifact).toContain('pipelines: declaredPipelines');
		expect(artifact).not.toMatch(/hookSourcePaths|declaredHooks/);

		const declared = await readFile(
			join(root, '.norbital', 'generated', 'declared-collections.d.ts'),
			'utf8'
		);
		expect(declared).toContain(
			'readonly "tickets": typeof import("../../src/collections/tickets/+collection.js").default;'
		);
		const collectionTypes = await readFile(
			join(root, '.norbital', 'types', 'collections', 'tickets', '$types.d.ts'),
			'utf8'
		);
		// The executed selection, as a literal: see renderCollectionTypes.
		expect(collectionTypes).toContain(
			'export type CreateInput = CollectionInputOf<Models["tickets"], { readonly input: {"columns":{"subject":true}} }, \'create\'>;'
		);
		expect(collectionTypes).toContain(
			'export type UpdateInput = CollectionInputOf<Models["tickets"], { readonly input: {"columns":{"subject":true}} }, \'update\'>;'
		);
		expect(collectionTypes).not.toContain('Hooks');
		const authoring = await readFile(
			join(root, '.norbital', 'types', 'workspace-authoring.d.ts'),
			'utf8'
		);
		expect(authoring).toContain('readonly collections: WorkspaceCollections;');
		expect(authoring).not.toContain('inputs');
	}, 180_000);
});
