import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { lockHash, materialize } from '../lib/depset.mjs';

const pnpmWorkspace = [
	'minimumReleaseAgeExclude: []',
	'supportedArchitectures:',
	'  os:',
	'    - current',
	'    - linux',
	'  cpu:',
	'    - current',
	'    - x64',
	'    - arm64',
	'  libc:',
	'    - glibc',
	'    - musl',
	''
].join('\n');

describe('depset addressing', () => {
	it('addresses a depset by its lockfile bytes alone', () => {
		const lockfile = 'lockfileVersion: 9.0\n';
		assert.equal(lockHash(lockfile), lockHash(lockfile));
		assert.notEqual(lockHash(lockfile), lockHash(`${lockfile}# changed\n`));
		assert.match(lockHash(lockfile), /^[0-9a-f]{32}$/);
	});

	it('agrees byte-for-byte with Core, which materializes the same depsets', () => {
		// Core's `sandbox/toolchain.server.ts` must produce identical hashes, or a depset one
		// side materializes would not be reusable by the other. Pinned with fixed vectors rather
		// than a cross-repo import: Core never reads this checkout, and these exact vectors are
		// asserted from that side in `tests/unit/tenant-workspace/depset.test.ts`.
		const vectors = [
			['', 'e3b0c44298fc1c149afbf4c8996fb924'],
			['lockfileVersion: 9.0\n', 'c98d2bd9d0bc739a5937aeba6ebfcb69'],
			['\u00e9 non-ascii bytes\n', 'b5194add2560b1093bfc054be8ad7faa']
		];
		for (const [lockfile, expected] of vectors) {
			assert.equal(lockHash(lockfile), expected, JSON.stringify(lockfile));
		}
	});

	it('treats an existing depset as a mount, not an install', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'norbital-depset-'));
		try {
			const lockfile = 'lockfileVersion: 9.0\n';
			const target = path.join(root, lockHash(lockfile));
			mkdirSync(target, { recursive: true });
			writeFileSync(
				path.join(target, '.norbital-depset-layout'),
				'host-plus-linux-musl-x64-arm64-v2'
			);
			const result = materialize({
				manifest: '{}',
				lockfile,
				pnpmWorkspace,
				// Reaching either of these would mean the present depset was not honoured.
				storeDirectory: path.join(root, 'absent-store'),
				depsetRoot: root
			});
			assert.equal(result.installed, false);
			assert.equal(result.lockHash, lockHash(lockfile));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('leaves no half-materialized depset behind when the install fails', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'norbital-depset-'));
		try {
			const lockfile = 'lockfileVersion: 9.0\nthis is not a lockfile\n';
			const manifestPath = path.join(root, 'unused.json');
			writeFileSync(manifestPath, '{}');
			assert.throws(() =>
				materialize({
					manifest: '{"name":"x","dependencies":{"no-such-package-xyz":"1.0.0"}}',
					lockfile,
					pnpmWorkspace,
					storeDirectory: path.join(root, 'store'),
					depsetRoot: root
				})
			);
			assert.throws(
				() => rmSync(path.join(root, lockHash(lockfile)), { recursive: true }),
				/ENOENT/,
				'a failed materialization must not publish a depset under its lockHash'
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('requires the projected supply-chain policy instead of taking host defaults', () => {
		assert.throws(
			() =>
				materialize({
					manifest: '{}',
					lockfile: 'lockfileVersion: 9.0\n',
					pnpmWorkspace: '',
					storeDirectory: '/not-used',
					depsetRoot: '/not-used'
				}),
			/pnpm-workspace\.yaml supply-chain policy/
		);
	});

	it('requires host and Linux/musl guest native dependency targets', () => {
		assert.throws(
			() =>
				materialize({
					manifest: '{}',
					lockfile: 'lockfileVersion: 9.0\n',
					pnpmWorkspace: 'minimumReleaseAgeExclude: []\n',
					storeDirectory: '/not-used',
					depsetRoot: '/not-used'
				}),
			/supportedArchitectures\.os/
		);
	});
});
