import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAssetIndex } from '../../src/compiler/workspace-build.js';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_DIRECTORY,
	SERVER_ASSET_DECLARATION_FILE_NAME,
	WORKSPACE_ENTRY_FILE_NAME
} from '../../src/compiler/client-entry.js';

/**
 * The asset diet, asserted on a built tree rather than on a build.
 *
 * Everything the index decides — which half a file lands in, what a blob is named, how many blobs
 * exist — is decided by what sits under `.norbital/dist` and by the declaration the Vite plugin
 * leaves there. Running the real Vite build twice to reach the same three facts would make this the
 * slowest suite in the package and would not test one additional line.
 */
const digest = (bytes: string | Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');

/** Materializes one workspace tree: a built client, an optional server-asset declaration, media. */
const workspaceWith = async (files: Readonly<Record<string, string>>, declared?: Array<string>) => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-asset-index-'));
	for (const [path, content] of Object.entries(files)) {
		const absolute = join(root, path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, 'utf8');
	}
	if (declared !== undefined) {
		await writeFile(
			join(root, '.norbital', 'dist', SERVER_ASSET_DECLARATION_FILE_NAME),
			JSON.stringify({ targets: declared }),
			'utf8'
		);
	}
	const artifactDirectory = join(root, ARTIFACT_DIRECTORY);
	const index = await Effect.runPromise(buildAssetIndex(root, 'fixture', artifactDirectory));
	return { root, artifactDirectory, index };
};

const client = `.norbital/dist/${WORKSPACE_ENTRY_FILE_NAME}`;

describe('artifact asset index', () => {
	it('writes every indexed byte to a blob named by its own digest', async () => {
		const { artifactDirectory, index } = await workspaceWith({
			[client]: 'export const mountWorkspace = () => {};',
			'.norbital/dist/assets/style.css': '.bolt-app { color: red; }',
			'assets/banner.svg': '<svg />'
		});

		expect(index.browser.map(({ path }) => path).toSorted()).toEqual(
			[
				'/assets/style.css',
				'/workspace.js',
				'/__bolt/request/api/template-seed-assets/fixture/banner.svg'
			].toSorted()
		);
		expect(index.server).toEqual([]);

		// The roundtrip that matters: every entry names a file that exists, whose bytes hash to the
		// digest the entry claims and whose length matches. A host re-verifies exactly this before
		// serving, so an index that cannot survive it is an artifact no host will accept.
		for (const entry of index.browser) {
			const bytes = await readFile(join(artifactDirectory, ARTIFACT_ASSET_DIRECTORY, entry.sha256));
			expect(digest(bytes)).toBe(entry.sha256);
			expect(bytes.byteLength).toBe(entry.byteLength);
		}

		// Asset indexing emits only content-addressed objects. The complete release document written by
		// `syncWorkspace` is the sole on-disk authority for these two arrays.
		expect(await readdir(artifactDirectory)).toEqual([ARTIFACT_ASSET_DIRECTORY]);
	});

	/**
	 * Declaring a file for the workspace's own runtime must not publish it.
	 *
	 * The plugin copies server assets into the same output directory as the compiled client, and the
	 * compiler used to index that whole directory as the public asset set — so a WebAssembly module an
	 * authored hook instantiates was reachable over HTTP the moment it was declared. Nothing about
	 * `node_modules/…` says "private"; the declaration does, and it is the only thing that does.
	 */
	it('keeps a declared server asset out of the browser half entirely', async () => {
		const target = 'node_modules/pdq-wasm/wasm/pdq.wasm';
		const { index } = await workspaceWith(
			{
				[client]: 'export const mountWorkspace = () => {};',
				[`.norbital/dist/${target}`]: 'wasm-bytes'
			},
			[target]
		);

		expect(index.browser.map(({ path }) => path)).toEqual(['/workspace.js']);
		expect(index.browser.some(({ path }) => path.includes('pdq'))).toBe(false);
		// Keyed exactly as declared: the guest's bridge asks `__artifactReadBytes` for this string, so
		// a leading slash or a URL prefix here is a key nothing can ever match.
		expect(index.server).toEqual([
			{
				path: target,
				contentType: 'application/wasm',
				sha256: digest('wasm-bytes'),
				byteLength: 10
			}
		]);
	});

	it('refuses a declaration the build did not honour', async () => {
		const failure = await Effect.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					const root = yield* Effect.promise(() =>
						mkdtemp(join(tmpdir(), 'bolt-asset-index-missing-'))
					);
					yield* Effect.promise(async () => {
						await mkdir(join(root, '.norbital', 'dist'), { recursive: true });
						await writeFile(join(root, client), 'export {};', 'utf8');
						await writeFile(
							join(root, '.norbital', 'dist', SERVER_ASSET_DECLARATION_FILE_NAME),
							JSON.stringify({ targets: ['node_modules/gone/gone.wasm'] }),
							'utf8'
						);
					});
					return yield* buildAssetIndex(root, 'fixture', join(root, ARTIFACT_DIRECTORY));
				})
			)
		);
		expect(failure.message).toContain('node_modules/gone/gone.wasm');
	});

	it('stores byte-identical files once, under the one name they share', async () => {
		const { artifactDirectory, index } = await workspaceWith({
			[client]: 'export const mountWorkspace = () => {};',
			'.norbital/dist/copy-a.css': '.same {}',
			'.norbital/dist/nested/copy-b.css': '.same {}'
		});

		const shared = index.browser.filter(({ path }) => path.endsWith('.css'));
		expect(shared).toHaveLength(2);
		expect(new Set(shared.map(({ sha256 }) => sha256)).size).toBe(1);
		// Content addressing is not an optimization applied afterwards — the digest *is* the filename,
		// so two paths with the same bytes cannot produce two files.
		const blobs = await readdir(join(artifactDirectory, ARTIFACT_ASSET_DIRECTORY));
		expect(blobs).toHaveLength(new Set(index.browser.map(({ sha256 }) => sha256)).size);
		expect(blobs).toContain(digest('.same {}'));
	});

	it('still refuses a build that emitted no client, declaration file or not', async () => {
		const failure = await Effect.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					const root = yield* Effect.promise(() =>
						mkdtemp(join(tmpdir(), 'bolt-asset-index-empty-'))
					);
					yield* Effect.promise(async () => {
						await mkdir(join(root, '.norbital', 'dist'), { recursive: true });
						await writeFile(
							join(root, '.norbital', 'dist', SERVER_ASSET_DECLARATION_FILE_NAME),
							JSON.stringify({ targets: [] }),
							'utf8'
						);
					});
					return yield* buildAssetIndex(root, 'fixture', join(root, ARTIFACT_DIRECTORY));
				})
			)
		);
		// The declaration is not output: a directory holding only it is still an empty build.
		expect(failure.message).toContain('No compiled client under');
	});
});
