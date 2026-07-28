import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repositoryRoot, '.local-packages');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-oss-pack-'));
const packages = [
	['@norbital-ai/config', 'config.tgz'],
	['@norbital-ai/std', 'std.tgz'],
	['@norbital-ai/platform-utils', 'platform-utils.tgz'],
	['@norbital-ai/ui', 'ui.tgz'],
	['@norbital-ai/pod', 'pod.tgz']
];

mkdirSync(outputDirectory, { recursive: true });

try {
	for (const [packageName, outputName] of packages) {
		const result = spawnSync(
			'pnpm',
			['--filter', packageName, 'pack', '--pack-destination', temporaryDirectory],
			{ cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' }
		);
		if (result.status !== 0) {
			throw new Error(
				[`Failed to pack ${packageName}`, result.stdout, result.stderr].filter(Boolean).join('\n')
			);
		}

		const tarball = readdirSync(temporaryDirectory).find((entry) => entry.endsWith('.tgz'));
		if (!tarball) throw new Error(`pnpm pack did not produce a tarball for ${packageName}`);
		copyFileSync(path.join(temporaryDirectory, tarball), path.join(outputDirectory, outputName));
		rmSync(path.join(temporaryDirectory, tarball));
		console.log(`${packageName} -> .local-packages/${outputName}`);
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
