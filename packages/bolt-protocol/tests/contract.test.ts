import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import * as Protocol from '../src/index.js';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_BUNDLE_FILE,
	ARTIFACT_RELEASE_FILE,
	artifactCodeGraphRefusals,
	ArtifactCodeGraph,
	AssetIndexEntry,
	BundleManifest,
	canonicalTenantReleaseEncoding,
	COMPILED_MANIFEST_VERSION,
	decodeBoltBundleModule,
	ManifestDestination,
	missingFacilities,
	PROTOCOL_VERSION,
	tenantReleaseObjects,
	TenantRelease,
	WorkspaceAuthoringManifest,
	type FacilityBindings
} from '../src/index.js';

const schemaPlan = {
	fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
	steps: []
} as const;

describe('facility contract', () => {
	it('exports only the versioned live-query protocol', () => {
		for (const symbol of [
			'SyncAnswer',
			'SyncPageAnswer',
			'SyncCursor',
			'SyncHeldCoordinate',
			'SyncPatch',
			'SyncApplyPatch',
			'SyncPrefixApplyFrame',
			'SyncAdvanceRefusal',
			'MAX_SYNC_HELD_IDS'
		])
			expect(Object.hasOwn(Protocol, symbol)).toBe(false);
		expect(Object.keys(Protocol.SyncApplyFrame.fields)).toEqual(['updates', 'resets', 'outcomes']);
	});

	it('exports the current compiled-manifest contract as runtime protocol values', () => {
		expect(COMPILED_MANIFEST_VERSION).toBe(2);
		expect(
			Schema.decodeUnknownSync(ManifestDestination)({
				kind: 'system',
				surface: 'automations',
				selection: 'nightly'
			})
		).toEqual({ kind: 'system', surface: 'automations', selection: 'nightly' });
		expect(
			Schema.decodeUnknownSync(WorkspaceAuthoringManifest)({
				name: 'fixture',
				version: '1',
				collections: [],
				apps: [],
				policies: [],
				automations: [],
				envoys: [],
				integrations: [],
				principals: [],
				requiredFacilities: []
			}).name
		).toBe('fixture');
	});

	it('reports required facility bindings deterministically', () => {
		const manifest: BundleManifest = {
			protocolVersion: PROTOCOL_VERSION,
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
			artifactId: 'fixture',
			artifactVersion: '1',
			schemaFingerprint: schemaPlan.fingerprint,
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
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
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
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
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

	it('carries the current projection version without refusing runtime rollback of older bundles', () => {
		const manifest = {
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

		expect(Schema.decodeUnknownResult(BundleManifest)(manifest)._tag).toBe('Success');
		expect(
			Schema.decodeUnknownResult(BundleManifest)({
				...manifest,
				compiledManifestVersion: COMPILED_MANIFEST_VERSION - 1
			})._tag
		).toBe('Success');
		expect(
			Schema.decodeUnknownResult(BundleManifest)({
				...manifest,
				compiledManifestVersion: COMPILED_MANIFEST_VERSION
			})._tag
		).toBe('Success');
	});

	/**
	 * `Schema.Struct` drops keys it does not name, so an undeclared key is not an error — it is a
	 * silent deletion on the way out of dispatch. The runtime has always sent `principals`, and the
	 * manifest contract did not carry it, so every client got a manifest with the list removed.
	 */
	it('carries the static identities the runtime can mint', () => {
		const decoded = Schema.decodeUnknownSync(WorkspaceAuthoringManifest)({
			name: 'fixture',
			version: '1',
			collections: [],
			apps: [],
			policies: [],
			automations: [],
			envoys: [],
			integrations: [],
			principals: [
				{ id: 'colony-system', label: 'Colony', kind: 'host', policies: [] },
				{ id: 'envoy:support', label: 'support', kind: 'envoy', policies: ['member'] }
			],
			requiredFacilities: []
		});
		expect(decoded.principals.map(({ id }) => id)).toEqual(['colony-system', 'envoy:support']);
	});

	it('rejects a current authored entity without its compiler-projected source path', () => {
		const manifest = {
			name: 'fixture',
			version: '1',
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
			collections: [],
			apps: [{ name: 'billing', label: 'Billing', origin: 'authored' }],
			policies: [],
			automations: [],
			envoys: [],
			integrations: [],
			principals: [],
			requiredFacilities: []
		};

		expect(Schema.decodeUnknownResult(WorkspaceAuthoringManifest)(manifest)._tag).toBe('Failure');
		expect(
			Schema.decodeUnknownResult(WorkspaceAuthoringManifest)({
				...manifest,
				apps: [
					{
						name: 'billing',
						label: 'Billing',
						origin: 'authored',
						sourcePath: 'src/apps/+billing.svelte'
					}
				]
			})._tag
		).toBe('Success');
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
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
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
				compiledManifestVersion: COMPILED_MANIFEST_VERSION,
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

	it('names the canonical artifact layout every host resolves a blob through', () => {
		expect(ARTIFACT_BUNDLE_FILE).toBe('bundle.mjs');
		expect(ARTIFACT_ASSET_DIRECTORY).toBe('assets');
		expect(ARTIFACT_RELEASE_FILE).toBe('release.json');
	});

	it('describes an independently verifiable ESM module graph', () => {
		const graph = Schema.decodeUnknownSync(ArtifactCodeGraph)({
			format: 'esm-v1',
			entrypoint: 'bundle.mjs',
			sha256: 'b'.repeat(64),
			byteLength: 9,
			chunks: [
				{
					path: 'bundle.mjs',
					role: 'tenant',
					sha256: 'c'.repeat(64),
					byteLength: 9,
					imports: [],
					dynamicImports: []
				}
			]
		});
		expect(graph.chunks.map(({ sha256 }) => sha256)).toEqual(['c'.repeat(64)]);
		expect(artifactCodeGraphRefusals(graph)).toEqual([]);
		const entryChunk = graph.chunks[0];
		if (entryChunk === undefined) throw new Error('fixture graph has no entry chunk');
		expect(
			artifactCodeGraphRefusals({
				...graph,
				chunks: [
					{
						...entryChunk,
						dynamicImports: [{ specifier: './lazy.mjs', target: 'lazy.mjs' }]
					}
				]
			})
		).toContain('dynamic imports are unsupported: bundle.mjs');
	});

	it('validates a complete release without importing its executable', () => {
		const decoded = Schema.decodeUnknownSync(TenantRelease)({
			formatVersion: 1,
			protocolVersion: PROTOCOL_VERSION,
			artifactId: 'fixture',
			artifactVersion: '1',
			requiredFacilities: [],
			code: {
				format: 'esm-v1',
				entrypoint: 'bundle.mjs',
				sha256: 'b'.repeat(64),
				byteLength: 9,
				chunks: [
					{
						path: 'bundle.mjs',
						role: 'tenant',
						sha256: 'c'.repeat(64),
						byteLength: 9,
						imports: [],
						dynamicImports: []
					}
				]
			},
			assets: { browser: [entry], server: [] },
			schema: {
				fingerprint: schemaPlan.fingerprint,
				description: {
					path: 'schema.json',
					role: 'schema',
					sha256: 'e'.repeat(64),
					byteLength: 20
				},
				migrations: {
					path: 'migrations.json',
					role: 'migration-lineage',
					sha256: 'f'.repeat(64),
					byteLength: 3
				}
			},
			provenance: {
				lockfile: {
					path: 'pnpm-lock.yaml',
					role: 'lockfile',
					sha256: 'd'.repeat(64),
					byteLength: 4
				},
				toolchain: { bolt: '0.0.5', node: '26.0.0', protocol: '4' }
			}
		});
		expect(decoded.schema.description.role).toBe('schema');
		expect(decoded.provenance.lockfile?.path).toBe('pnpm-lock.yaml');
		expect(tenantReleaseObjects(decoded).map(({ role }) => role)).toEqual([
			'tenant',
			'browser-asset',
			'schema',
			'migration-lineage',
			'lockfile'
		]);
		const changed = TenantRelease.make({
			...decoded,
			assets: { ...decoded.assets, browser: [{ ...entry, sha256: '9'.repeat(64) }] }
		});
		expect(canonicalTenantReleaseEncoding(changed)).not.toBe(
			canonicalTenantReleaseEncoding(decoded)
		);
	});
});
