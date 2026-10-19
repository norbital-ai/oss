import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path, Result } from 'effect';
import { expect } from 'vitest';
import { build } from 'vite';
import { clientImportBoundary } from '../src/compiler/artifact/client-boundary.ts';
import type { Discovered } from '../src/compiler/discover.ts';

it.live(
	'blocks transitive server source, raw/url, encoded and symlink imports while preserving helpers and type imports',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-client-boundary-' });
			const root = yield* fs.realPath(temporary);
			const files: readonly Discovered[] = [
				{ role: 'collection', name: 'private', path: 'src/data/collection/private/+collection.ts' },
				{ role: 'model', name: 'private', path: 'src/data/model/+private.model.ts' },
				{ role: 'secrets', name: '', path: 'src/+secrets.ts' },
				{ role: 'automation', name: 'private', path: 'src/automation/+private.automation.ts' },
				{ role: 'policy', name: 'private', path: 'src/access_control/policy/+private.policy.ts' },
				{
					role: 'integration_definition',
					name: 'private',
					path: 'src/integration/private/+integration.ts'
				},
				{ role: 'agent', name: '', path: 'src/agent/+agent.md' },
				{ role: 'messages', name: '', path: 'src/i18n/+messages.ts' }
			];
			const write = (file: string, contents: string) =>
				fs
					.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
					.pipe(Effect.andThen(fs.writeFileString(path.join(root, file), contents)));
			for (const file of files)
				yield* write(
					file.path,
					file.role === 'agent'
						? 'SERVER_ONLY_CANARY'
						: file.role === 'messages'
							? 'export default { title: "Public label" };'
							: 'export type PrivateShape = { name: string }; export default "SERVER_ONLY_CANARY";'
				);
			for (const file of [
				'src/lib/credentials.server.ts',
				'src/lib/server/credentials.ts',
				'.env',
				'.env.local'
			])
				yield* write(
					file,
					file.startsWith('.')
						? 'SECRET=SERVER_ONLY_CANARY'
						: 'export default "SERVER_ONLY_CANARY";'
				);
			yield* write(
				'node_modules/folder-dependency/package.json',
				JSON.stringify({
					name: 'folder-dependency',
					type: 'module',
					exports: { '.': './dist/server/renderTree.js', './direct': './dist/helper.server.js' }
				})
			);
			yield* write(
				'node_modules/folder-dependency/dist/server/renderTree.js',
				'export const tree = "Dependency server folder allowed";'
			);
			yield* write(
				'node_modules/folder-dependency/dist/helper.server.js',
				'export const helper = "Dependency server filename allowed";'
			);
			yield* write(
				'src/lib/shared.ts',
				'import type { PrivateShape } from "../data/model/+private.model.ts"; import messages from "../i18n/+messages.ts"; import { tree } from "folder-dependency"; import { helper } from "folder-dependency/direct"; const input: PrivateShape = { name: messages.title }; export const value = [input.name, tree, helper].join(" ");'
			);
			yield* write(
				'entry.ts',
				'import { value } from "./src/lib/shared.ts"; globalThis.boundary = value;'
			);
			const bundle = () =>
				Effect.tryPromise({
					try: () =>
						build({
							configFile: false,
							root,
							logLevel: 'silent',
							resolve: { preserveSymlinks: true },
							plugins: [clientImportBoundary(root, files)],
							build: {
								write: false,
								minify: false,
								rolldownOptions: { input: path.join(root, 'entry.ts') }
							}
						}),
					catch: (cause) => new Error(String(cause))
				});
			const allowed = yield* bundle();
			const outputs = Array.isArray(allowed) ? allowed : [allowed];
			const code = outputs
				.flatMap((output) =>
					'output' in output
						? output.output.map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
						: []
				)
				.join('\n');
			expect(code).toContain('Public label');
			expect(code).toContain('Dependency server folder allowed');
			expect(code).toContain('Dependency server filename allowed');
			expect(code).not.toContain('SERVER_ONLY_CANARY');
			yield* fs.symlink(
				path.join(root, 'src/data/collection/private/+collection.ts'),
				path.join(root, 'src/lib/ordinary.ts')
			);
			yield* fs.symlink(
				path.join(root, 'src/lib/server/credentials.ts'),
				path.join(root, 'node_modules/folder-dependency/dist/browser.ts')
			);
			yield* fs.symlink(
				path.join(root, 'src/data/collection/private/+collection.ts'),
				path.join(root, 'node_modules/folder-dependency/dist/declared.ts')
			);
			yield* write(
				'entry.ts',
				'import value from "./src/lib/bridge.ts"; globalThis.boundary = value;'
			);
			for (const target of [
				'../data/collection/private/+collection.ts?raw',
				'../data/model/+private.model.ts',
				'../+secrets.ts?url',
				'../automation/+private.automation.ts',
				'../access_control/policy/+private.policy.ts?raw',
				'../integration/private/+integration.ts?url',
				'../agent/+agent.md?raw',
				'./credentials.server.ts?url',
				'./server/credentials.ts?raw',
				'../../.env?raw',
				'../../.env.local?url',
				'../../%2eenv?raw',
				'./ordinary.ts?raw',
				'../../node_modules/folder-dependency/dist/browser.ts?raw',
				'../../node_modules/folder-dependency/dist/declared.ts?url'
			]) {
				yield* write('src/lib/bridge.ts', `export { default } from ${JSON.stringify(target)};`);
				const result = yield* bundle().pipe(Effect.result);
				expect(Result.isFailure(result), target).toBe(true);
				if (Result.isFailure(result))
					expect(result.failure.message, target).toContain(
						'Server-only module cannot be imported by the client'
					);
			}
		}).pipe(Effect.provide(NodeServices.layer)),
	30_000
);
