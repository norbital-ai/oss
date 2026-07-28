import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertSha512Integrity, sha512Integrity } from '../lib/package-archive.mjs';
import { platformPackageKey } from '../lib/package-release.mjs';

const entries = [
	{
		name: '@norbital-ai/pod',
		version: '0.0.1',
		tarball: 'https://registry.example.test/pod-a.tgz',
		integrity: sha512Integrity(Buffer.from('pod archive'))
	},
	{
		name: '@norbital-ai/ui',
		version: '0.1.25',
		tarball: 'https://registry.example.test/ui-a.tgz',
		integrity: sha512Integrity(Buffer.from('ui archive'))
	}
];

describe('published package identity', () => {
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
});
