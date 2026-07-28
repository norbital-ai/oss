import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha512Integrity } from '../lib/package-archive.mjs';
import { platformPackageKey, readPublicPackageEntries } from '../lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
	cwd: repositoryRoot,
	encoding: 'utf8'
}).trim();
const imageDigest = `sha256:${'a'.repeat(64)}`;

function generate(directory, registry, tarballOrigin) {
	const entries = readPublicPackageEntries(repositoryRoot).map((entry) => ({
		...entry,
		tarball: `${tarballOrigin}/${entry.name.slice('@norbital-ai/'.length)}.tgz`,
		integrity: sha512Integrity(Buffer.from(`${entry.name}@${entry.version}`))
	}));
	const packageRelease = {
		schemaVersion: 1,
		registry,
		packageKey: platformPackageKey(entries),
		entries
	};
	const templateRevisions = {
		schemaVersion: 1,
		source: {
			repository: 'https://git.example.test/norbital/oss.git',
			revision: sourceRevision
		},
		entries: [
			{
				key: 'construction',
				ref: 'refs/heads/templates/construction',
				revision: sourceRevision,
				name: 'Construction Operations',
				industry: 'Construction',
				description: 'Construction operations.',
				visibility: 'public',
				counts: { collections: 16, apps: 3, automations: 4 },
				compatiblePod: '^0.0.1'
			}
		]
	};
	const packageReleasePath = path.join(directory, 'packages.json');
	const templateRevisionsPath = path.join(directory, 'templates.json');
	const outputPath = path.join(directory, `release-${encodeURIComponent(registry)}.json`);
	writeFileSync(packageReleasePath, JSON.stringify(packageRelease));
	writeFileSync(templateRevisionsPath, JSON.stringify(templateRevisions));
	execFileSync(
		process.execPath,
		[
			path.join(repositoryRoot, 'scripts/generate-platform-release.mjs'),
			'--source-revision',
			sourceRevision,
			'--source-repository',
			'https://git.example.test/norbital/oss.git',
			'--package-release',
			packageReleasePath,
			'--template-revisions',
			templateRevisionsPath,
			'--builder-image',
			'registry.example.test/norbital/builder',
			'--builder-digest',
			imageDigest,
			'--runtime-image',
			'registry.example.test/norbital/runtime',
			'--runtime-digest',
			imageDigest,
			'--created-at',
			'2026-07-29T00:00:00.000Z',
			'--output',
			outputPath
		],
		{ cwd: repositoryRoot, stdio: 'ignore' }
	);
	return JSON.parse(readFileSync(outputPath, 'utf8'));
}

describe('platform release package content', () => {
	it('requires exact archive metadata but keeps provider mirrors out of the build identity', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'norbital-platform-release-test-'));
		try {
			const first = generate(
				directory,
				'https://registry-one.example.test',
				'https://registry-one.example.test/tarballs'
			);
			const mirrored = generate(
				directory,
				'https://registry-two.example.test',
				'https://cdn.example.test/packages'
			);
			assert.equal(first.buildContractId, mirrored.buildContractId);
			assert.equal(first.packages.packageKey, mirrored.packages.packageKey);
			assert.notEqual(first.packages.registry, mirrored.packages.registry);
			for (const entry of first.packages.entries) {
				assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
				assert.match(entry.tarball, /^https:/);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
