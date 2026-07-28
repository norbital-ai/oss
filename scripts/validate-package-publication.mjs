import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repositoryRoot, '.tmp', 'publication-check');
const repositoryLicense = readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8');
const packageDirectories = ['config', 'platform-utils', 'pod', 'std', 'ui'];
const localProtocol = /^(?:workspace|catalog|file|link|portal):/;

function fail(message) {
	throw new Error(message);
}

function validatePublishedManifest(manifest, directory) {
	if (manifest.private) fail(`${manifest.name} is marked private.`);
	if (!manifest.name?.startsWith('@norbital-ai/'))
		fail(`${directory} has an invalid package name.`);
	if (!manifest.version) fail(`${manifest.name} has no version.`);
	if (manifest.license !== 'SEE LICENSE IN LICENSE') {
		fail(`${manifest.name} must reference the repository license.`);
	}
	if (manifest.repository?.directory !== `packages/${directory}`) {
		fail(`${manifest.name} has an invalid repository directory.`);
	}
	if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
		fail(`${manifest.name} must publish publicly with provenance.`);
	}
	for (const section of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies'
	]) {
		for (const [name, version] of Object.entries(manifest[section] ?? {})) {
			if (localProtocol.test(version)) {
				fail(`${manifest.name} publishes ${section}.${name} with local protocol ${version}.`);
			}
		}
	}
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
try {
	for (const directory of packageDirectories) {
		const packageDirectory = path.join(repositoryRoot, 'packages', directory);
		const packOutput = execFileSync(
			'pnpm',
			['pack', '--json', '--pack-destination', outputDirectory],
			{ cwd: packageDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
		);
		const result = JSON.parse(packOutput);
		const filename = Array.isArray(result) ? result[0]?.filename : result.filename;
		if (!filename) fail(`pnpm pack did not report an archive for packages/${directory}.`);
		const manifestText = execFileSync('tar', ['-xOf', filename, 'package/package.json'], {
			encoding: 'utf8'
		});
		const packagedLicense = execFileSync('tar', ['-xOf', filename, 'package/LICENSE'], {
			encoding: 'utf8'
		});
		if (packagedLicense !== repositoryLicense) {
			fail(`${directory} does not publish the repository license.`);
		}
		validatePublishedManifest(JSON.parse(manifestText), directory);
	}
	console.log(`Validated ${packageDirectories.length} standalone public package archives.`);
} finally {
	rmSync(outputDirectory, { recursive: true, force: true });
}
