import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { describe, expect } from 'vitest';
import {
	actualCounts,
	checkTemplates,
	discoverTemplates,
	lockTemplates,
	publishTemplates,
	resolveLockfile,
	testTemplates,
	unsatisfiedFirstPartyPeers,
	withoutThirdParty
} from '../src/cli/templates.ts';

const metadata = {
	schema_version: 1,
	key: 'norbital_fixture',
	name: 'Fixture',
	industry: 'Operations',
	description: 'Fixture workspace',
	visibility: 'public',
	counts: { models: 0, apps: 0, automations: 0 },
	tags: []
};
/** A bun.lock (JSON with trailing commas): `packages` maps an install path to `[id, registry, meta, integrity]`. */
const bunLock = (packages: Record<string, readonly unknown[]>) =>
	`${JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'fixture' } }, packages }, null, 2).replace(/\n(\s*)([}\]])/g, ',\n$1$2')}\n`;
/** A template in `root` pinning `bolt`: this CLI's own release unless named. */
const template = Effect.fnUntraced(function* (
	root: string,
	slug: string,
	manifest: object,
	bolt?: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { version: own } = yield* Schema.decodeUnknownEffect(
		Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
	)(yield* fs.readFileString(path.join(import.meta.dirname, '..', 'package.json')));
	const directory = path.join(root, slug);
	yield* fs.makeDirectory(directory);
	yield* fs.writeFileString(
		path.join(directory, 'norbital.template.json'),
		JSON.stringify(manifest)
	);
	yield* fs.writeFileString(
		path.join(directory, 'package.json'),
		JSON.stringify({
			private: true,
			scripts: { build: 'bolt build', test: 'bolt test' },
			dependencies: { '@norbital-ai/bolt': bolt ?? own }
		})
	);
	yield* fs.writeFileString(path.join(directory, 'bun.lock'), bunLock({}));
	return directory;
});
const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-template-cli-' });
	return { root, directory: yield* template(root, 'fixture', metadata) };
});
describe('bolt templates', () => {
	it.live('discovers metadata and resolves both a directory slug and a handle', () =>
		Effect.gen(function* () {
			const { root } = yield* fixture;
			const templates = yield* discoverTemplates(root);
			expect(templates).toHaveLength(1);
			expect(yield* discoverTemplates(root, 'fixture')).toEqual(templates);
			expect(yield* discoverTemplates(root, 'norbital_fixture')).toEqual(templates);
			expect(
				(yield* discoverTemplates(root, 'no-such-template').pipe(Effect.flip)).message
			).toContain('No template matched');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('tests only templates it can name, and names those it cannot', () =>
		Effect.gen(function* () {
			const { root } = yield* fixture;
			expect(
				(yield* testTemplates(root, ['fixture', 'no-such-template']).pipe(Effect.flip)).message
			).toBe('No template matched no-such-template.');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('counts named source files without helpers and refuses picker count drift', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { root, directory } = yield* fixture;
			for (const file of [
				'src/data/model/agreements/+model.ts',
				'src/data/model/agreements/fees/+model.ts',
				'src/data/model/helpers.ts',
				'src/data/model/fees/README.md',
				'src/app/service/+app.ts',
				'src/app/service/+agreements.page.svelte',
				'src/automation/+fee_review.automation.ts'
			]) {
				yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true });
				yield* fs.writeFileString(path.join(directory, file), '');
			}
			expect(yield* actualCounts(directory)).toEqual({ models: 2, apps: 1, automations: 1 });
			expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain(
				'declares 0 models'
			);
			yield* fs.writeFileString(
				path.join(directory, 'norbital.template.json'),
				JSON.stringify({ ...metadata, counts: { models: 2, apps: 1, automations: 1 } })
			);
			yield* checkTemplates(root);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('requires an exact first-party pin, a committed bun.lock and no pnpm files', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { root, directory } = yield* fixture;
			yield* checkTemplates(root);
			yield* fs.writeFileString(path.join(directory, 'pnpm-workspace.yaml'), '');
			expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain(
				'pnpm-workspace.yaml has no place'
			);
			yield* fs.remove(path.join(directory, 'pnpm-workspace.yaml'));
			yield* fs.remove(path.join(directory, 'bun.lock'));
			expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain('missing bun.lock');
			yield* fs.writeFileString(
				path.join(directory, 'package.json'),
				JSON.stringify({
					private: true,
					scripts: { build: 'bolt build', test: 'bolt test' },
					dependencies: { '@norbital-ai/bolt': '^0.0.1' }
				})
			);
			expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain('exact version');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('refuses source imports outside the template and misplaced committed migrations', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { root, directory } = yield* fixture;
			yield* fs.makeDirectory(path.join(directory, 'src'));
			yield* fs.writeFileString(
				path.join(directory, 'src/foreign.ts'),
				"import data from '../../seed_bank/private.json';"
			);
			expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain('seed_bank');
			yield* fs.remove(path.join(directory, 'src/foreign.ts'));
			yield* fs.makeDirectory(path.join(directory, '.norbital/migrations'), { recursive: true });
			expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toBe(
				'fixture: committed migrations belong in migrations/, beside src/'
			);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('runs a sibling on another Bolt release through its own toolchain, unread', () =>
		Effect.gen(function* () {
			const { root } = yield* fixture;
			// another release's manifest shape: this CLI's schema cannot decode it, and never tries
			yield* template(
				root,
				'older',
				{ schemaVersion: 1, key: 'norbital_older', counts: { models: 0 } },
				'0.0.1'
			);
			const delegated: Array<readonly [string, readonly string[]]> = [];
			const delegate = (sibling: { slug: string }, args: readonly string[]) =>
				Effect.sync(() => {
					delegated.push([sibling.slug, args]);
					return '';
				});
			expect((yield* discoverTemplates(root)).map(({ handle, bolt }) => [handle, bolt])).toEqual([
				['norbital_fixture', expect.any(String)],
				['norbital_older', '0.0.1']
			]);
			yield* checkTemplates(root, 'fixture', delegate);
			expect(delegated).toEqual([]);
			yield* checkTemplates(root, undefined, delegate);
			yield* lockTemplates({ root, filter: 'older', check: true }, delegate);
			yield* publishTemplates({ root, out: 'out', filter: 'norbital_older' }, delegate);
			expect(delegated).toEqual([
				['older', ['check']],
				['older', ['lock', '--check']],
				['older', ['publish', `--out=${root}/out`]]
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('resolves a lockfile from the committed one without its first-party entries', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { root, directory } = yield* fixture;
			yield* fs.writeFileString(
				path.join(directory, 'bun.lock'),
				bunLock({
					'@norbital-ai/bolt': ['@norbital-ai/bolt@0.0.1', '', {}, 'sha512-old'],
					effect: ['effect@4.0.0', '', {}, 'sha512-e']
				})
			);
			const template = (yield* discoverTemplates(root))[0];
			if (template === undefined) throw new Error('fixture template missing');
			const resolved = yield* resolveLockfile(template, (command, args, options) =>
				Effect.gen(function* () {
					expect(command).toBe('bun');
					expect(args).toEqual(expect.arrayContaining(['install', '--lockfile-only']));
					if (options?.cwd === undefined) throw new Error('fixture execution cwd missing');
					const handed = yield* fs.readFileString(path.join(options.cwd, 'bun.lock'));
					expect(handed).not.toContain('sha512-old');
					expect(handed).toContain('sha512-e');
					return '';
				})
			);
			expect(resolved).not.toContain('sha512-old');
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
it.effect('holds a lockfile to its first-party entries and specifiers, not floated third-party versions', () =>
	Effect.gen(function* () {
		const lock = (ui: string, helpers: string) =>
			bunLock({
				'@norbital-ai/ui': ['@norbital-ai/ui@0.0.1', '', {}, ui],
				'@swc/helpers': [`@swc/helpers@${helpers}`, '', {}, `sha512-${helpers}`]
			});
		const held = yield* withoutThirdParty(lock('sha512-a', '0.5.23'));
		expect(yield* withoutThirdParty(lock('sha512-a', '0.5.24'))).toBe(held);
		expect(yield* withoutThirdParty(lock('sha512-b', '0.5.23'))).not.toBe(held);
		expect(yield* withoutThirdParty(lock('sha512-a', '0.5.23').replace('fixture', 'other'))).not.toBe(held);
	})
);

it.effect('names an exact peer the locked install resolves to another version', () =>
	Effect.gen(function* () {
		const lock = (effect: string) =>
			bunLock({
				'@norbital-ai/bolt': [
					'@norbital-ai/bolt@0.0.103',
					'',
					{ peerDependencies: { effect: '4.0.0-rc.112', svelte: '^5.0.0' } },
					'sha512-x'
				],
				effect: [`effect@${effect}`, '', {}, 'sha512-e']
			});
		expect(yield* unsatisfiedFirstPartyPeers(lock('4.0.0-rc.111'))).toEqual([
			'@norbital-ai/bolt@0.0.103 needs effect@4.0.0-rc.112 but the install resolves effect@4.0.0-rc.111'
		]);
		expect(yield* unsatisfiedFirstPartyPeers(lock('4.0.0-rc.112'))).toEqual([]);
	})
);
