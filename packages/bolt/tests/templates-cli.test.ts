import { it } from '@effect/vitest';
import { fileURLToPath } from 'node:url';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Option, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { describe, expect } from 'vitest';
import {
	actualCounts,
	changedSince,
	checkTemplates,
	discoverTemplates,
	publishTemplates,
	resolveLockfile,
	run,
	testTemplates,
	unsatisfiedFirstPartyPeers,
	verifyTemplates,
	withoutFirstParty
} from '../src/cli/templates.ts';

const metadata = {
	schemaVersion: 1,
	key: 'norbital_fixture',
	name: 'Fixture',
	industry: 'Operations',
	description: 'Fixture workspace',
	visibility: 'public',
	counts: { models: 0, apps: 0, automations: 0 },
	tags: []
};
const policy =
	"minimumReleaseAgeExclude:\n - '@norbital-ai/bolt@0.0.1'\nsupportedArchitectures:\n os:\n  - darwin\n  - linux\n  - win32\n cpu:\n  - x64\n  - arm64\n libc:\n  - glibc\n  - musl\n";
const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-template-cli-' });
	const directory = path.join(root, 'fixture');
	yield* fs.makeDirectory(directory);
	yield* fs.writeFileString(
		path.join(directory, 'norbital.template.json'),
		JSON.stringify(metadata)
	);
	yield* fs.writeFileString(
		path.join(directory, 'package.json'),
		JSON.stringify({
			private: true,
			scripts: { build: 'bolt build', test: 'bolt test' },
			dependencies: { '@norbital-ai/bolt': '0.0.1' }
		})
	);
	yield* fs.writeFileString(path.join(directory, 'pnpm-workspace.yaml'), policy);
	yield* fs.writeFileString(path.join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
	return { root, directory };
});
describe('bolt templates', () => {
	it.live('discovers metadata and resolves both a directory slug and a handle', () =>
		Effect.gen(function* () {
			const { root } = yield* fixture;
			const templates = yield* discoverTemplates(root);
			expect(templates).toHaveLength(1);
			expect(templates[0]?.ref).toBe('refs/heads/templates/fixture');
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
				'src/data/model/fees/+model.ts',
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
	it.live(
		'requires exact first-party pins, explicit exemptions, architectures and a committed lock',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const { root, directory } = yield* fixture;
				yield* checkTemplates(root);
				yield* fs.writeFileString(
					path.join(directory, 'pnpm-workspace.yaml'),
					policy.replace('@norbital-ai/bolt@0.0.1', '@norbital-ai/*')
				);
				expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain('exact versions');
				yield* fs.writeFileString(
					path.join(directory, 'pnpm-workspace.yaml'),
					policy.replace(' - darwin', ' - other')
				);
				expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain(
					'supported architecture'
				);
				yield* fs.writeFileString(path.join(directory, 'pnpm-workspace.yaml'), policy);
				yield* fs.remove(path.join(directory, 'pnpm-lock.yaml'));
				expect((yield* checkTemplates(root).pipe(Effect.flip)).message).toContain(
					'missing pnpm-lock.yaml'
				);
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
	it.live('preserves the committed dependency resolution while generating a lockfile', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const { root, directory } = yield* fixture;
			const committed = 'lockfileVersion: 9.0\n# example remains at 1.0.0 even when 1.1.0 exists\n';
			const patch = yield* fs.readFileString(
				fileURLToPath(new URL('../../../patches/isolated-vm@7.0.1.patch', import.meta.url))
			);
			yield* fs.writeFileString(path.join(directory, 'isolated-vm.patch'), patch);
			yield* fs.writeFileString(
				path.join(directory, 'pnpm-workspace.yaml'),
				`${policy}patchedDependencies: {"isolated-vm@7.0.1": "isolated-vm.patch"}\n`
			);
			yield* fs.writeFileString(path.join(directory, 'pnpm-lock.yaml'), committed);
			const template = (yield* discoverTemplates(root))[0];
			if (template === undefined) throw new Error('fixture template missing');
			const resolved = yield* resolveLockfile(template, (command, args, options) =>
				Effect.gen(function* () {
					expect(command).toBe('pnpm');
					expect(options?.cwd).toBeDefined();
					if (options?.cwd === undefined) throw new Error('fixture execution cwd missing');
					expect(yield* fs.readFileString(path.join(options.cwd, 'pnpm-lock.yaml'))).toBe(
						committed
					);
					expect(yield* fs.readFileString(path.join(options.cwd, 'isolated-vm.patch'))).toBe(patch);
					// install resolves the rest; update re-resolves the first-party entries install would skip
					expect(args[0] === 'install' ? args : ['--no-frozen-lockfile']).toContain(
						'--no-frozen-lockfile'
					);
					if (args[0] === 'update')
						expect(args).toEqual(expect.arrayContaining(['@norbital-ai/*', '--lockfile-only']));
					expect(args).not.toContain('--force');
					expect(args).not.toContain('--ignore-workspace');
					return '';
				})
			);
			expect(resolved).toBe(committed);
			expect(yield* fs.readFileString(path.join(directory, 'pnpm-lock.yaml'))).toBe(committed);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('verifies clean projections, each suite its own bolt test', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const created = yield* fixture;
			const root = yield* fs.realPath(created.root);
			const directory = path.join(root, 'fixture');
			yield* fs.writeFileString(
				path.join(directory, 'package.json'),
				JSON.stringify({
					private: true,
					scripts: { build: 'bolt build', test: 'bolt test' }
				})
			);
			yield* run('git', ['init', '--initial-branch=main'], { cwd: root });
			const native = yield* ChildProcessSpawner.ChildProcessSpawner;
			const commands: (readonly string[])[] = [];
			const processes = ChildProcessSpawner.make((command) =>
				Effect.gen(function* () {
					if (command._tag !== 'StandardCommand' || command.command !== 'pnpm')
						return yield* native.spawn(command);
					commands.push(command.args);
					const cwd = command.options.cwd;
					if (cwd === undefined) throw new Error('standalone command cwd missing');
					expect(yield* fs.exists(path.join(cwd, '..', 'seed_bank'))).toBe(false);
					if (command.args[0] === 'exec') {
						const artifact = path.join(cwd, '.norbital', 'artifact');
						yield* fs.makeDirectory(artifact, { recursive: true });
						yield* fs.writeFileString(path.join(artifact, 'artifact.json'), '{}');
					}
					return yield* native.spawn(ChildProcess.make(process.execPath, ['-e', '']));
				})
			);
			const tested: (readonly string[])[] = [];
			// each suite's own `bolt test` builds what it tests
			const tester = (projections: string, only: readonly string[]) =>
				Effect.gen(function* () {
					tested.push(only);
					for (const slug of only) {
						const artifact = path.join(projections, slug, '.norbital', 'artifact');
						yield* fs.makeDirectory(artifact, { recursive: true });
						yield* fs.writeFileString(path.join(artifact, 'artifact.json'), '{}');
					}
				}).pipe(Effect.orDie);
			yield* verifyTemplates(root, undefined, tester).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, processes)
			);
			// fetched with the registry, installed without it, checked with the template's own Bolt
			expect(commands).toEqual([
				['fetch', '--frozen-lockfile'],
				['install', '--frozen-lockfile', '--offline'],
				['exec', 'bolt', 'check']
			]);
			expect(tested).toEqual([['fixture']]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
const lockfile = (effect: string) =>
	`packages:\n\n  '@norbital-ai/bolt@0.0.103':\n    resolution: {integrity: sha512-x}\n    peerDependencies:\n      '@norbital-ai/doctor': 0.0.103\n      effect: 4.0.0-rc.112\n      svelte: ^5.0.0\n\nsnapshots:\n\n  '@norbital-ai/bolt@0.0.103(@norbital-ai/doctor@0.0.103)(@tiptap/pm@3.31.3(effect@4.0.0-rc.1))(effect@${effect})(svelte@5.57.0)':\n    dependencies: {}\n`;
it.effect('names an exact peer the locked install resolves to another version', () =>
	Effect.sync(() => {
		expect(unsatisfiedFirstPartyPeers(lockfile('4.0.0-rc.111'))).toEqual([
			'@norbital-ai/bolt@0.0.103 needs effect@4.0.0-rc.112 but the install resolves effect@4.0.0-rc.111'
		]);
		expect(unsatisfiedFirstPartyPeers(lockfile('4.0.0-rc.112'))).toEqual([]);
	})
);

it.live(
	'publishes a projected ref and refuses a non-fast-forward local replacement',
	() =>
		Effect.gen(function* () {
			const { root } = yield* fixture;
			const git = (args: readonly string[]) => run('git', args, { cwd: root });
			yield* git(['init', '--initial-branch=main']);
			yield* git(['config', 'user.email', 'template-fixture@example.test']);
			yield* git(['config', 'user.name', 'Template fixture']);
			yield* git(['add', '.']);
			yield* git(['commit', '-m', 'fixture']);
			yield* publishTemplates({
				root,
				sourceRevision: 'HEAD',
				repository: 'fixture',
				updateLocal: true
			});
			expect(yield* git(['show', 'refs/heads/templates/fixture:norbital.template.json'])).toBe(
				JSON.stringify(metadata)
			);
			const unrelated = yield* git(['rev-parse', 'HEAD']);
			yield* git(['update-ref', 'refs/heads/templates/fixture', unrelated]);
			expect(
				(yield* publishTemplates({
					root,
					sourceRevision: 'HEAD',
					repository: 'fixture',
					updateLocal: true
				}).pipe(Effect.flip)).message
			).toContain('merge-base --is-ancestor');
			expect(yield* git(['rev-parse', 'refs/heads/templates/fixture'])).toBe(unrelated);
		}).pipe(Effect.provide(NodeServices.layer)),
	30_000
);

it.live('names the templates changed since a revision, and none it cannot resolve', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const { root, directory } = yield* fixture;
		const git = (args: readonly string[]) => run('git', args, { cwd: root });
		yield* git(['init', '--initial-branch=main']);
		yield* git(['config', 'user.email', 'template-fixture@example.test']);
		yield* git(['config', 'user.name', 'Template fixture']);
		yield* git(['add', '.']);
		yield* git(['commit', '-m', 'fixture']);
		expect(yield* changedSince(root, 'HEAD')).toEqual(Option.some(new Set()));
		yield* fs.writeFileString(path.join(directory, 'README.md'), 'changed');
		expect(yield* changedSince(root, 'HEAD')).toEqual(Option.some(new Set(['fixture'])));
		expect(yield* changedSince(root, 'origin/main')).toEqual(Option.none());
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it('drops first-party package and snapshot entries so a republished version re-resolves; importers keep theirs', () => {
	const lock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@norbital-ai/bolt':\n        specifier: 0.0.1\n        version: 0.0.1\n\npackages:\n\n  '@norbital-ai/bolt@0.0.1':\n    resolution: {integrity: sha512-old}\n\n  effect@4.0.0:\n    resolution: {integrity: sha512-e}\n\nsnapshots:\n\n  '@norbital-ai/bolt@0.0.1(effect@4.0.0)':\n    dependencies: {}\n\n  effect@4.0.0: {}\n`;
	const stripped = withoutFirstParty(lock);
	expect(stripped).not.toContain('sha512-old');
	expect(stripped).not.toContain("'@norbital-ai/bolt@0.0.1(");
	expect(stripped).toContain("'@norbital-ai/bolt':\n        specifier: 0.0.1");
	expect(stripped).toContain('effect@4.0.0:\n    resolution');
	expect(stripped).toContain('  effect@4.0.0: {}');
});
