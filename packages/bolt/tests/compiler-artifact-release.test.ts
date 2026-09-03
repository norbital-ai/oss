import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_RELEASE_FILE,
	canonicalArtifactCodeGraphIndexEncoding,
	PROTOCOL_VERSION,
	TenantRelease
} from '@norbital-ai/bolt-protocol';
import {
	buildCodeGraph,
	buildTenantRelease,
	readSchemaProvenance,
	serverModulePartition,
	writeTenantRelease
} from '../src/compiler/artifact-release.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const releaseIdentity = {
	protocolVersion: PROTOCOL_VERSION,
	artifactId: '@template/fixture:local',
	artifactVersion: '1.2.3',
	requiredFacilities: ['database'],
	schema: {
		path: 'compiler-schema.json',
		bytes: new TextEncoder().encode('{"collections":["fixture"]}\n'),
		fingerprint: 'sha256:fixture-logical-schema'
	}
} as const;

const bytes = (source: string): Uint8Array => new TextEncoder().encode(source);
const emittedCode = (dependency = 'export const dependency = 1;') => [
	{
		path: 'bundle.mjs',
		role: 'tenant' as const,
		imports: ['code/runtime-a.mjs', 'code/tenant-a.mjs'],
		dynamicImports: [],
		bytes: bytes("import './code/runtime-a.mjs'; import './code/tenant-a.mjs';")
	},
	{
		path: 'code/runtime-a.mjs',
		role: 'runtime' as const,
		imports: ['code/dependency-effect-a.mjs'],
		dynamicImports: [],
		bytes: bytes("import './dependency-effect-a.mjs'; export const runtime = 1;")
	},
	{
		path: 'code/dependency-effect-a.mjs',
		role: 'dependency' as const,
		imports: [],
		dynamicImports: [],
		bytes: bytes(dependency)
	},
	{
		path: 'code/tenant-a.mjs',
		role: 'tenant' as const,
		imports: [],
		dynamicImports: [],
		bytes: bytes('export const tenant = 1;')
	}
];

describe('tenant release sidecar', () => {
	it('refuses to synthesize schema provenance without committed migration lineage', async () => {
		await expect(readSchemaProvenance('/missing-workspace', [])).rejects.toThrow(
			'release requires a committed migration lineage'
		);
	});

	it('never evaluates the built guest artifact in the compiler process', async () => {
		const releaseWriter = await readFile(
			new URL('../src/compiler/artifact-release.ts', import.meta.url),
			'utf8'
		);
		expect(releaseWriter).not.toContain('eval(');
		expect(releaseWriter).not.toContain('new Function(');
	});

	it('records the exact ESM resolver graph and independently verifies every emitted module', () => {
		const built = buildCodeGraph('bundle.mjs', emittedCode());
		expect(built.graph.format).toBe('esm-v1');
		expect(built.graph.chunks.map(({ role }) => role)).toEqual([
			'tenant',
			'dependency',
			'runtime',
			'tenant'
		]);
		expect(built.graph.chunks.find(({ path }) => path === 'bundle.mjs')?.imports).toEqual([
			{ specifier: './code/runtime-a.mjs', target: 'code/runtime-a.mjs' },
			{ specifier: './code/tenant-a.mjs', target: 'code/tenant-a.mjs' }
		]);
		for (const chunk of built.graph.chunks) {
			expect(sha256(built.objects.get(chunk.sha256) ?? new Uint8Array())).toBe(chunk.sha256);
		}
		const { sha256: graphDigest, ...graphIndex } = built.graph;
		expect(sha256(bytes(canonicalArtifactCodeGraphIndexEncoding(graphIndex)))).toBe(graphDigest);
	});

	it('changes only the dependency node when one dependency output changes', () => {
		const before = buildCodeGraph('bundle.mjs', emittedCode());
		const after = buildCodeGraph('bundle.mjs', emittedCode('export const dependency = 2;'));
		const beforeByPath = new Map(before.graph.chunks.map((chunk) => [chunk.path, chunk.sha256]));
		for (const chunk of after.graph.chunks) {
			expect(chunk.sha256 === beforeByPath.get(chunk.path)).toBe(chunk.role !== 'dependency');
		}
		expect(after.graph.sha256).not.toBe(before.graph.sha256);
	});

	it('rejects a graph with a dynamic import the isolate cannot resolve safely', () => {
		const [entry, ...rest] = emittedCode();
		if (entry === undefined) throw new Error('fixture graph has no entry');
		expect(() =>
			buildCodeGraph('bundle.mjs', [{ ...entry, dynamicImports: ['code/tenant-a.mjs'] }, ...rest])
		).toThrow('unsupported dynamic imports');
	});

	it('partitions runtime, dependencies, and tenant modules from compiler provenance', () => {
		const input = {
			workspaceRoot: '/workspaces/acme',
			platformPackagesRoot: '/platform/packages',
			artifactEntry: '/workspaces/acme/.norbital/artifact/bundle-entry.mjs'
		};
		expect(serverModulePartition('/workspaces/acme/src/+model.ts', input)?.role).toBe('tenant');
		expect(serverModulePartition('/platform/packages/bolt/src/runtime/app.ts', input)?.role).toBe(
			'runtime'
		);
		expect(
			serverModulePartition('/store/node_modules/effect/dist/esm/Effect.js', input)?.role
		).toBe('dependency');
		expect(serverModulePartition('/workspaces/acme/node_modules/zod/index.js', input)?.role).toBe(
			'dependency'
		);
		expect(serverModulePartition(input.artifactEntry, input)).toBeUndefined();
	});

	it('publishes code and lockfile objects before one standalone release document', async () => {
		const artifactDirectory = await mkdtemp(join(tmpdir(), 'bolt-release-'));
		const lockfile = new TextEncoder().encode('lockfileVersion: 9\n');
		const written = await writeTenantRelease(artifactDirectory, {
			...releaseIdentity,
			assets: { browser: [], server: [] },
			migrations: [{ tag: '20260826000000_fixture', statements: ['create table fixture'] }],
			code: { entrypoint: 'bundle.mjs', chunks: emittedCode() },
			lockfile: { path: 'pnpm-lock.yaml', bytes: lockfile },
			toolchain: { protocol: '4', node: '26.0.0', bolt: '0.0.5' }
		});

		const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(TenantRelease))(
			await readFile(join(artifactDirectory, ARTIFACT_RELEASE_FILE), 'utf8')
		);
		expect(decoded).toEqual(written.release);
		expect(sha256(written.manifestBytes)).toBe(written.releaseId);
		expect(Object.keys(decoded.provenance.toolchain)).toEqual(['bolt', 'node', 'protocol']);
		const references = [
			...decoded.code.chunks.map(({ sha256: value }) => value),
			decoded.schema.description.sha256,
			decoded.schema.migrations.sha256,
			decoded.provenance.lockfile?.sha256
		].filter((value): value is string => value !== undefined);
		for (const reference of references) {
			const bytes = await readFile(join(artifactDirectory, ARTIFACT_ASSET_DIRECTORY, reference));
			expect(sha256(bytes)).toBe(reference);
		}
	});

	it('reports only missing objects when a deploy already owns shared chunks', () => {
		const built = buildTenantRelease({
			...releaseIdentity,
			assets: { browser: [], server: [] },
			migrations: [],
			code: { entrypoint: 'bundle.mjs', chunks: emittedCode() },
			lockfile: undefined,
			toolchain: { bolt: '0.0.5', node: '26.0.0', protocol: '4' }
		});
		const first = built.release.code.chunks[0];
		if (first === undefined) throw new Error('fixture executable emitted no chunks');
		const alreadyPresent = new Set(
			[...built.objects.keys()].filter((value) => value !== first.sha256)
		);
		const missing = [...built.objects.keys()].filter((value) => !alreadyPresent.has(value));
		expect(missing).toEqual([first.sha256]);
	});

	it('publishes the compiler logical schema fingerprint without changing content-addressed schema bytes', () => {
		const logicalFingerprint = 'sha256:compiler-owned-logical-schema';
		const built = buildTenantRelease({
			...releaseIdentity,
			schema: { ...releaseIdentity.schema, fingerprint: logicalFingerprint },
			assets: { browser: [], server: [] },
			migrations: [],
			code: { entrypoint: 'bundle.mjs', chunks: emittedCode() },
			lockfile: undefined,
			toolchain: { bolt: '0.0.5', node: '26.0.0', protocol: '4' }
		});
		expect(built.release.schema.fingerprint).toBe(logicalFingerprint);
		expect(built.release.schema.description.sha256).toBe(sha256(releaseIdentity.schema.bytes));
	});

	it('identifies the complete manifest independently from the code graph digest', () => {
		const base = buildTenantRelease({
			...releaseIdentity,
			assets: { browser: [], server: [] },
			migrations: [],
			code: { entrypoint: 'bundle.mjs', chunks: emittedCode() },
			lockfile: undefined,
			toolchain: { bolt: '0.0.5', node: '26.0.0', protocol: '4' }
		});
		const assetOnlyChange = buildTenantRelease({
			...releaseIdentity,
			assets: {
				browser: [
					{
						path: '/workspace.css',
						contentType: 'text/css; charset=utf-8',
						sha256: 'a'.repeat(64),
						byteLength: 12
					}
				],
				server: []
			},
			migrations: [],
			code: { entrypoint: 'bundle.mjs', chunks: emittedCode() },
			lockfile: undefined,
			toolchain: { bolt: '0.0.5', node: '26.0.0', protocol: '4' }
		});
		expect(assetOnlyChange.release.code.sha256).toBe(base.release.code.sha256);
		expect(assetOnlyChange.releaseId).not.toBe(base.releaseId);
	});
});
