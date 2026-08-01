import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyPodServerAssets } from '$lib/vite/index.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Pod server asset sidecars', () => {
	it('copies an explicit dependency sidecar into the immutable server artifact', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'pod-server-assets-'));
		roots.push(root);
		const source = path.join(root, 'decoder.wasm');
		const output = path.join(root, 'output', 'server');
		await writeFile(source, new Uint8Array([0, 97, 115, 109]));

		await copyPodServerAssets(output, [{ source, target: 'runtime/decoder.wasm' }]);

		expect(await readFile(path.join(output, 'runtime', 'decoder.wasm'))).toEqual(
			Buffer.from([0, 97, 115, 109])
		);
	});

	it('refuses a sidecar target that escapes output/server', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'pod-server-assets-'));
		roots.push(root);
		const source = path.join(root, 'decoder.wasm');
		await writeFile(source, 'wasm');

		await expect(
			copyPodServerAssets(path.join(root, 'output', 'server'), [
				{ source, target: '../outside.wasm' }
			])
		).rejects.toThrow(/must stay below output\/server/);
	});
});
