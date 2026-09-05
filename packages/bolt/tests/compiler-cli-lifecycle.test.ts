import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Exercise the executable consumers receive. The test task depends on this package's build;
// running source through jiti also transpiles the compiler graph before the CLI can start.
const cli = join(packageRoot, 'build/compiler/cli.js');
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
			await run(process.execPath, [cli, 'sync', '--root', root], { cwd: packageRoot });
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof Error) || !('code' in failure) || !('stderr' in failure))
			throw new Error('Bolt sync unexpectedly succeeded');

		expect(failure.code).toBe(1);
		expect(String(failure.stderr)).toContain('Bolt sync failed:');
		expect(String(failure.stderr)).not.toContain('node:internal/process/promises');
	});

	it('writes doctor evidence under .norbital/diagnosis for bolt audit --json', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bolt-cli-audit-'));
		temporaryRoots.push(root);
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(join(root, 'package.json'), '{"name":"bolt-cli-audit","type":"module"}\n');
		await writeFile(join(root, 'src', 'ok.ts'), 'export const value = 1;\n');

		const ran = await run(process.execPath, [cli, 'audit', '--root', root, '--json'], {
			cwd: packageRoot
		}).catch((failure: NodeJS.ErrnoException & { stdout?: string }) => failure);
		const stdout = 'stdout' in ran ? String(ran.stdout) : '';
		expect(stdout).toContain('"cataloguePath"');
		expect(stdout).toContain('.norbital/diagnosis');

		const receipt = JSON.parse(
			await readFile(join(root, '.norbital', 'diagnosis', 'receipt.json'), 'utf8')
		) as { complete: boolean; findings: string };
		expect(receipt.complete).toBe(true);
		expect(receipt.findings).toBe('findings.tsv');
		await readFile(join(root, '.norbital', 'diagnosis', 'findings.tsv'));
		await readFile(join(root, '.norbital', 'diagnosis', 'metrics.tsv'));
	}, 60_000);
});
