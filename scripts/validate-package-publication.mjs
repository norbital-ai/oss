import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspectPackageArchive } from './lib/package-archive.mjs';
import { publicPackageDirectories } from './lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repositoryRoot, '.tmp', 'publication-check');
const repositoryLicense = readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8');
function fail(message) {
	throw new Error(message);
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
try {
	for (const directory of publicPackageDirectories) {
		const packageDirectory = path.join(repositoryRoot, 'packages', directory);
		const packOutput = execFileSync(
			'pnpm',
			['pack', '--json', '--pack-destination', outputDirectory],
			{ cwd: packageDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
		);
		const result = JSON.parse(packOutput);
		const filename = Array.isArray(result) ? result[0]?.filename : result.filename;
		if (!filename) fail(`pnpm pack did not report an archive for packages/${directory}.`);
		inspectPackageArchive(filename, { directory, repositoryLicense });
	}
	console.log(`Validated ${publicPackageDirectories.length} standalone public package archives.`);
} finally {
	rmSync(outputDirectory, { recursive: true, force: true });
}
