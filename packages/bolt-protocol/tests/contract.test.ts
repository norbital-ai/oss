import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_ASSET_INDEX_FILE,
	ARTIFACT_BUNDLE_FILE,
	ArtifactAssetIndex,
	AssetIndexEntry,
	BundleManifest,
	decodeBoltBundleModule,
	missingFacilities,
	PROTOCOL_VERSION,
	type FacilityBindings
} from '../src/index.js';

const schemaPlan = { fingerprint: 'fnv1a32:test', steps: [] } as const;

describe('facility contract', () => {
	it('reports required facility bindings deterministically', () => {
		const manifest: BundleManifest = {
			protocolVersion: PROTOCOL_VERSION,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			schemaPlan,
			requiredFacilities: ['database', 'ai', 'transport'],
			browserAssets: [],
			serverAssets: [],
			integrations: []
		};
		const bindings: FacilityBindings = {
			scope: { tenantId: 'tenant-1', environment: 'test', releaseId: 'release-1' }
		};
		expect(missingFacilities(manifest, bindings)).toEqual(['database', 'ai', 'transport']);
	});

	it('treats transport as a host facility distinct from communication', () => {
		const manifest: BundleManifest = {
			protocolVersion: PROTOCOL_VERSION,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			schemaPlan,
			requiredFacilities: ['communication', 'transport'],
			browserAssets: [],
			serverAssets: [],
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
			protocolVersion: PROTOCOL_VERSION,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			schemaPlan,
			requiredFacilities: [],
			browserAssets: [],
			serverAssets: [],
			integrations: []
		};
		const decoded = await Effect.runPromise(
			decodeBoltBundleModule({
				protocolVersion: PROTOCOL_VERSION,
				manifest,
				dispatch: () =>
					Promise.resolve({ _tag: 'Success', response: { status: 200, headers: {} } }),
				activate: () =>
					Promise.resolve({ _tag: 'Activated', registrations: [], nextDueAtEpochMs: null })
			})
		);
		expect(decoded.manifest.artifactId).toBe('fixture');
	});
});

describe('artifact asset index', () => {
	const entry = {
		path: '/workspace.js',
		contentType: 'text/javascript; charset=utf-8',
		sha256: 'a'.repeat(64),
		byteLength: 12
	};

	it('describes an asset without carrying it', () => {
		const decoded = Schema.decodeUnknownSync(AssetIndexEntry)(entry);
		expect(decoded).toEqual(entry);
		// The field that used to hold 13 MB of base64 per WebAssembly module. A release that still
		// tries to ship bytes through the manifest is refused rather than quietly re-inflated.
		expect(Object.keys(AssetIndexEntry.fields)).toEqual([
			'path',
			'contentType',
			'sha256',
			'byteLength'
		]);
		expect(Schema.decodeUnknownResult(AssetIndexEntry)({ ...entry, byteLength: -1 })._tag).toBe(
			'Failure'
		);
	});

	it('splits browser assets from server assets in the manifest itself', () => {
		const manifest = Schema.decodeUnknownSync(BundleManifest)({
			protocolVersion: PROTOCOL_VERSION,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: 'sha256:test',
			schemaPlan,
			requiredFacilities: [],
			browserAssets: [entry],
			serverAssets: [{ ...entry, path: 'node_modules/pdq-wasm/wasm/pdq.wasm' }],
			integrations: []
		});
		expect(manifest.browserAssets.map(({ path }) => path)).toEqual(['/workspace.js']);
		expect(manifest.serverAssets.map(({ path }) => path)).toEqual([
			'node_modules/pdq-wasm/wasm/pdq.wasm'
		]);
		// Both are required, for the same reason `requiredFacilities` is: absent has to be
		// distinguishable from empty, and an optional field cannot say "this artifact ships nothing".
		expect(
			Schema.decodeUnknownResult(BundleManifest)({
				protocolVersion: PROTOCOL_VERSION,
				artifactId: 'fixture',
				artifactVersion: '1',
				schemaFingerprint: 'sha256:test',
				schemaPlan,
				requiredFacilities: [],
				browserAssets: [],
				integrations: []
			})._tag
		).toBe('Failure');
	});

	it('names the sidecar layout every host resolves a blob through', () => {
		expect(ARTIFACT_BUNDLE_FILE).toBe('bundle.mjs');
		expect(ARTIFACT_ASSET_DIRECTORY).toBe('assets');
		expect(ARTIFACT_ASSET_INDEX_FILE).toBe('asset-index.json');
		expect(Schema.decodeUnknownSync(ArtifactAssetIndex)({ browser: [entry], server: [] })).toEqual({
			browser: [entry],
			server: []
		});
	});
});
