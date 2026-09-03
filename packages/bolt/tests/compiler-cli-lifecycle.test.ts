import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageRoot, 'src/compiler/cli.ts');
const jiti = join(packageRoot, 'node_modules/.bin/jiti');
const temporaryRoots: Array<string> = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('Bolt CLI lifecycle', () => {
	it('waits for an asynchronous sync failure and exits nonzero without an unhandled stack', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bolt-cli-lifecycle-'));
		temporaryRoots.push(root);

		let failure: unknown;
		try {
			await run(jiti, [cli, 'sync', '--root', root], { cwd: packageRoot });
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof Error) || !('code' in failure) || !('stderr' in failure))
			throw new Error('Bolt sync unexpectedly succeeded');

		expect(failure.code).toBe(1);
		expect(String(failure.stderr)).toContain('Bolt sync failed:');
		expect(String(failure.stderr)).not.toContain('node:internal/process/promises');
	});
});
