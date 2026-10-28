import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, layer } from '@effect/vitest';
import { Effect, FileSystem, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
	assertSha512Integrity,
	packedArchiveFilename,
	sha512Integrity
} from '../lib/package-archive.ts';
import {
	platformPackageKey,
	publicPackageDirectories,
	readManifest,
	readPublicPackageEntries
} from '../lib/package-release.ts';
import {
	Packument,
	PublishedVersion,
	resolvePublishedPackages,
	resolveWorkspacePackages
} from '../resolve-published-packages.ts';
import { ScriptLive } from '../runtime.ts';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = [
	{
		name: '-ai/bolt',
		version: '0.0.1',
		tarball: 'https://registry.example.test/bolt-a.tgz',
		integrity: sha512Integrity(Buffer.from('bolt archive'))
	},
	{
		name: '@norbital-ai/ui',
		version: '0.0.1',
		tarball: 'https://registry.example.test/ui-a.tgz',
		integrity: sha512Integrity(Buffer.from('ui archive'))
	}
] as const;
describe('published package identity', () => {
	it('emits and verifies exact sha512 SRI', () => {
		const bytes = Buffer.from('published archive bytes');
		const integrity = sha512Integrity(bytes);
		assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
		assert.doesNotThrow(() => assertSha512Integrity(bytes, integrity));
		assert.throws(
			() => assertSha512Integrity(Buffer.from('different archive bytes'), integrity),
			/does not match/
		);
	});
	it('keys package content while excluding provider-specific tarball URLs', () => {
		const original = platformPackageKey(entries);
		const moved = platformPackageKey(
			entries.map((entry) => ({
				...entry,
				tarball: entry.tarball.replace('registry.example.test', 'mirror.example.test')
			}))
		);
		const changed = platformPackageKey([
			{ ...entries[0], integrity: sha512Integrity(Buffer.from('replaced bolt archive')) },
			entries[1]
		]);
		assert.equal(original, moved);
		assert.notEqual(original, changed);
	});
	it('is independent of entry ordering', () => {
		assert.equal(platformPackageKey(entries), platformPackageKey([...entries].reverse()));
	});
	it('reads a pack report after package lifecycle output', () => {
		const output = [
			'$ pnpm build',
			'src -> build',
			JSON.stringify([{ filename: '/tmp/norbital-ai-bolt-0.0.1.tgz' }], null, 2)
		].join('\n');
		assert.equal(packedArchiveFilename(output), '/tmp/norbital-ai-bolt-0.0.1.tgz');
	});
	it('a selected packument version refuses missing dist.integrity', () => {
		const missing = { dist: { tarball: 'https://registry.invalid/package.tgz' } };
		assert.equal(Result.isFailure(Schema.decodeUnknownResult(PublishedVersion)(missing)), true);
		assert.equal(
			Result.isSuccess(
				Schema.decodeUnknownResult(PublishedVersion)({
					dist: { ...missing.dist, integrity: sha512Integrity(Buffer.from('archive')) }
				})
			),
			true
		);
		// Older unrelated versions need not carry the selected release's fields.
		assert.equal(
			Result.isSuccess(Schema.decodeUnknownResult(Packument)({ versions: { old: missing } })),
			true
		);
	});
});
layer(ScriptLive, { excludeTestServices: true })('release files and archives', (it) => {
	it.effect('boots before any workspace package has been built', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped({
				prefix: 'norbital-package-manifest-test-'
			});
			const file = path.join(directory, 'package.json');
			yield* fs.writeFileString(file, '{"name":"@norbital-ai/example"}\n');
			assert.deepEqual(yield* readManifest(file), { name: '@norbital-ai/example' });
			yield* fs.writeFileString(file, '[]\n');
			const error = yield* Effect.flip(readManifest(file));
			assert.match(error.message, /is not a JSON object/);
		})
	);
	it.effect('refuses a registry version with missing integrity before requesting an archive', () =>
		Effect.gen(function* () {
			const locals = yield* readPublicPackageEntries(repositoryRoot);
			let archives = 0;
			const fetch: typeof globalThis.fetch = async (input) => {
				const url = String(input);
				if (url.endsWith('.tgz')) {
					archives += 1;
					return new Response('unsafe');
				}
				return Response.json({
					versions: Object.fromEntries(
						locals.map((local) => [
							local.version,
							{ dist: { tarball: 'https://other.invalid/archive.tgz' } }
						])
					)
				});
			};
			const failure = yield* Effect.flip(
				resolvePublishedPackages({
					registryUrl: 'https://registry.invalid/',
					token: Redacted.make('must-not-appear')
				}).pipe(
					Effect.provide(FetchHttpClient.layer),
					Effect.provideService(FetchHttpClient.Fetch, fetch)
				)
			);
			assert.match(failure.message, /dist.integrity/);
			assert.doesNotMatch(failure.message, /must-not-appear/);
			assert.equal(archives, 0);
		})
	);
});
