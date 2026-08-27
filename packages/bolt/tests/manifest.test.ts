import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/manifest/manifest.js';

describe('manifest fingerprint', () => {
	it('preserves the stable SHA-256 contract without a Node.js crypto runtime', () => {
		expect(
			fingerprint({
				z: [3, 'two', undefined],
				a: { b: true, a: undefined }
			})
		).toBe('sha256:770c004a34b94bcb9c335a220c4f8eaa794d50bbd1f350b47474e8ec5253f5c5');
	});
});
