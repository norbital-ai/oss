import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	decodeBoltBundleModule,
	missingFacilities,
	type BundleManifest,
	type FacilityBindings
} from '../src/index.js';

describe('facility contract', () => {
	it('reports required facility bindings deterministically', () => {
		const manifest: BundleManifest = {
			protocolVersion: 1,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			requiredFacilities: ['database', 'ai', 'transport'],
			staticAssets: [],
			integrations: []
		};
		const bindings: FacilityBindings = {
			scope: { tenantId: 'tenant-1', environment: 'test', releaseId: 'release-1' }
		};
		expect(missingFacilities(manifest, bindings)).toEqual(['database', 'ai', 'transport']);
	});

	it('treats transport as a host facility distinct from communication', () => {
		const manifest: BundleManifest = {
			protocolVersion: 1,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			requiredFacilities: ['communication', 'transport'],
			staticAssets: [],
			integrations: []
		};
		const bindings: FacilityBindings = {
			scope: { tenantId: 'tenant-1', environment: 'test', releaseId: 'release-1' },
			communication: {
				call: async () => ({ _tag: 'Success', value: {} })
			}
		};
		expect(missingFacilities(manifest, bindings)).toEqual(['transport']);
	});

	it('validates an unknown dynamic bundle module', async () => {
		const manifest: BundleManifest = {
			protocolVersion: 1,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			requiredFacilities: [],
			staticAssets: [],
			integrations: []
		};
		const decoded = await Effect.runPromise(
			decodeBoltBundleModule({
				protocolVersion: 1,
				manifest,
				dispatch: () => Promise.resolve({ _tag: 'Success', response: { status: 200, headers: {} } }),
				activate: () => Promise.resolve({ _tag: 'Activated', registrations: [] })
			})
		);
		expect(decoded.manifest.artifactId).toBe('fixture');
	});
});
