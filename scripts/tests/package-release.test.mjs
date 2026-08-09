import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	assertSha512Integrity,
	packedArchiveFilename,
	sha512Integrity
} from '../lib/package-archive.mjs';
import {
	assertBetaPackageVersions,
	betaPackageVersion,
	platformPackageKey,
	publicPackageDirectories,
	readPublicPackageEntries
} from '../lib/package-release.mjs';
import { resolveWorkspacePackages } from '../resolve-published-packages.mjs';
import { repositoryRoot } from '../lib/templates.mjs';

const entries = [
	{
		name: '@norbital-ai/pod',
		version: '0.0.1',
		tarball: 'https://registry.example.test/pod-a.tgz',
		integrity: sha512Integrity(Buffer.from('pod archive'))
	},
	{
		name: '@norbital-ai/ui',
		version: '0.0.1',
		tarball: 'https://registry.example.test/ui-a.tgz',
		integrity: sha512Integrity(Buffer.from('ui archive'))
	}
];

describe('published package identity', () => {
	it('keeps every public beta package at exactly 0.0.1', () => {
		const packages = readPublicPackageEntries(repositoryRoot);
		assert.equal(betaPackageVersion, '0.0.1');
		assert.doesNotThrow(() => assertBetaPackageVersions(packages));
		assert.throws(
			() => assertBetaPackageVersions([{ name: '@norbital-ai/pod', version: '0.0.2' }]),
			/@norbital-ai\/pod@0\.0\.2/
		);
	});

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
		const movedRegistry = platformPackageKey(
			entries.map((entry) => ({
				...entry,
				tarball: entry.tarball.replace('registry.example.test', 'mirror.example.test')
			}))
		);
		const changedBytes = platformPackageKey([
			{ ...entries[0], integrity: sha512Integrity(Buffer.from('replaced pod archive')) },
			entries[1]
		]);
		assert.equal(original, movedRegistry);
		assert.notEqual(original, changedBytes);
	});

	it('is independent of entry ordering', () => {
		assert.equal(platformPackageKey(entries), platformPackageKey([...entries].reverse()));
	});

	it('reads a pack report after package lifecycle output', () => {
		const output = [
			'$ pnpm build',
			'src -> build',
			JSON.stringify([{ filename: '/tmp/norbital-ai-pod-0.0.1.tgz' }], null, 2)
		].join('\n');
		assert.equal(packedArchiveFilename(output), '/tmp/norbital-ai-pod-0.0.1.tgz');
	});
});

describe('workspace package archives', () => {
	it('packs exact source bytes without changing checked-in semantic versions', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'norbital-workspace-packages-test-'));
		const repeatedDirectory = mkdtempSync(
			path.join(tmpdir(), 'norbital-workspace-packages-repeat-test-')
		);
		try {
			const release = resolveWorkspacePackages({
				archiveBaseUrl: 'https://releases.example.test/platform-v1/',
				archiveOutput: directory
			});
			const repeatedRelease = resolveWorkspacePackages({
				archiveBaseUrl: 'https://mirror.example.test/platform-v1/',
				archiveOutput: repeatedDirectory
			});
			assert.equal(release.entries.length, publicPackageDirectories.length);
			assert.equal(release.packageKey, platformPackageKey(release.entries));
			assert.equal(repeatedRelease.packageKey, release.packageKey);
			assert.deepEqual(
				repeatedRelease.entries.map(({ name, version, integrity }) => ({
					name,
					version,
					integrity
				})),
				release.entries.map(({ name, version, integrity }) => ({ name, version, integrity }))
			);
			const pod = release.entries.find((entry) => entry.name === '@norbital-ai/pod');
			// Compared against the checked-in manifest, not a literal. What this test is for is that
			// packing does not *invent* or *rewrite* a version — hardcoding the current one turned it
			// into a version pin that fails on any release, which says nothing about packing.
			const podManifest = JSON.parse(
				readFileSync(path.join(repositoryRoot, 'packages', 'pod', 'package.json'), 'utf8')
			);
			assert.equal(pod?.version, podManifest.version);
			assert.equal(pod?.tarball, 'https://releases.example.test/platform-v1/pod.tgz');
			for (const packageDirectory of publicPackageDirectories) {
				assert.equal(existsSync(path.join(directory, `${packageDirectory}.tgz`)), true);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
			rmSync(repeatedDirectory, { recursive: true, force: true });
		}
	});
});
