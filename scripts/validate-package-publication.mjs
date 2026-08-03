import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertDeclarationEmit } from './lib/declaration-emit.mjs';
import { inspectPackageArchive, packedArchiveFilename } from './lib/package-archive.mjs';
import { publicPackageDirectories } from './lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repositoryRoot, '.tmp', 'publication-check');
const repositoryLicense = readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8');

/**
 * `prepack` is the only hook every pack path goes through — `changeset publish` in the release
 * workflow, a developer's `pnpm pack`, and this check. It must therefore build through turbo rather
 * than call the package's own `build` directly: turbo's `^build` is what guarantees the workspace
 * dependencies exist before the compiler reads them, and a compiler that reads a missing one emits
 * `any` and exits 0.
 */
const expectedPrepack = (name) => `pnpm exec turbo run build --filter=${name}`;

function fail(message) {
	throw new Error(message);
}

/**
 * Read the declarations out of the archive itself.
 *
 * Everything else in this repository inspects a working tree. The tarball is the only artifact the
 * registry ever sees, and a GitHub Packages version can never be reused — so the last check before
 * a publish is made against the bytes that would be uploaded, not against the directory they were
 * supposed to have come from.
 */
function assertArchiveDeclarations(archivePath, directory) {
	const unpacked = path.join(outputDirectory, `unpacked-${directory}`);
	rmSync(unpacked, { recursive: true, force: true });
	mkdirSync(unpacked, { recursive: true });
	execFileSync('tar', ['-xzf', archivePath, '-C', unpacked], {
		stdio: ['ignore', 'ignore', 'inherit']
	});
	const declarationRoot = path.join(unpacked, 'package', 'build');
	if (!existsSync(declarationRoot)) {
		fail(`@norbital-ai/${directory} packs no build/ directory.`);
	}
	assertDeclarationEmit({
		declarationRoot,
		packageDirectory: directory,
		label: `${path.basename(archivePath)} (packed archive)`
	});
	rmSync(unpacked, { recursive: true, force: true });
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
try {
	for (const directory of publicPackageDirectories) {
		const packageDirectory = path.join(repositoryRoot, 'packages', directory);
		const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
		if (manifest.scripts?.build) {
			if (manifest.scripts.prepack !== expectedPrepack(manifest.name)) {
				fail(`${manifest.name} must build through turbo during prepack.`);
			}
			rmSync(path.join(packageDirectory, 'build'), { recursive: true, force: true });
		}
		const packOutput = execFileSync(
			'pnpm',
			['pack', '--json', '--pack-destination', outputDirectory],
			{ cwd: packageDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
		);
		const filename = packedArchiveFilename(packOutput, `pnpm pack for packages/${directory}`);
		inspectPackageArchive(filename, { directory, repositoryLicense });
		if (manifest.scripts?.build) assertArchiveDeclarations(filename, directory);
	}
	console.log(`Validated ${publicPackageDirectories.length} standalone public package archives.`);
} finally {
	rmSync(outputDirectory, { recursive: true, force: true });
}
