import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type {
	ArtifactAssetIndex,
	ArtifactCodeChunk,
	ArtifactCodeGraph,
	FacilityName,
	ProtocolVersion,
	TenantRelease
} from '@norbital-ai/bolt-protocol';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_RELEASE_FILE,
	artifactCodeGraphRefusals,
	canonicalArtifactCodeGraphIndexEncoding,
	canonicalTenantReleaseEncoding
} from '@norbital-ai/bolt-protocol';
import type { WorkspaceMigrationEntry } from '../authoring/workspace-schema.js';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Canonical byte representation of structured release objects. */
const jsonBytes = (value: unknown): Uint8Array =>
	new TextEncoder().encode(`${JSON.stringify(value, null, '\t')}\n`);

/**
 * One compiler-owned partition for Rolldown's `codeSplitting.groups` and its release role.
 */
export type ServerCodeRole = ArtifactCodeChunk['role'];
export type ServerModulePartition = Readonly<{
	readonly name: string;
	readonly role: ServerCodeRole;
}>;

const normalizedModuleId = (id: string): string => id.split('?')[0]?.replaceAll('\\', '/') ?? id;
const isWithin = (path: string, root: string): boolean =>
	path === root || path.startsWith(`${root}/`);
const safeChunkName = (value: string): string => value.replaceAll(/[^a-zA-Z0-9_-]/g, '-');

/** Assigns one transformed module from compiler-known provenance; no module is imported to decide. */
export const serverModulePartition = (
	id: string,
	input: Readonly<{
		readonly workspaceRoot: string;
		readonly platformPackagesRoot: string;
		readonly artifactEntry: string;
	}>
): ServerModulePartition | undefined => {
	const moduleId = normalizedModuleId(id);
	const artifactEntry = normalizedModuleId(input.artifactEntry);
	if (moduleId === artifactEntry) return undefined;
	const marker = '/node_modules/';
	const offset = moduleId.lastIndexOf(marker);
	if (offset >= 0) {
		const segments = moduleId.slice(offset + marker.length).split('/');
		const packageName =
			segments[0]?.startsWith('@') === true
				? `${segments[0]}/${segments[1] ?? 'unknown'}`
				: (segments[0] ?? 'unknown');
		return {
			name: `dependency-${safeChunkName(packageName)}-${createHash('sha256').update(packageName).digest('hex').slice(0, 8)}`,
			role: 'dependency'
		};
	}
	const workspaceRoot = normalizedModuleId(input.workspaceRoot);
	if (isWithin(moduleId, workspaceRoot)) return { name: 'tenant', role: 'tenant' };
	const platformPackagesRoot = normalizedModuleId(input.platformPackagesRoot);
	if (isWithin(moduleId, platformPackagesRoot)) return { name: 'runtime', role: 'runtime' };
	// Stable virtual compiler modules are platform machinery. An unknown absolute file is a resolved
	// third-party dependency and gets one deterministic anonymous partition rather than tenant trust.
	return moduleId.startsWith('\0')
		? { name: 'runtime', role: 'runtime' }
		: { name: 'dependency-anonymous', role: 'dependency' };
};

export type EmittedServerChunk = Readonly<{
	readonly path: string;
	readonly role: ServerCodeRole;
	readonly imports: ReadonlyArray<string>;
	readonly dynamicImports: ReadonlyArray<string>;
	readonly bytes: Uint8Array;
}>;

const graphImport = (importer: string, target: string) => {
	const relative = posix.relative(posix.dirname(importer), target);
	return { specifier: relative.startsWith('.') ? relative : `./${relative}`, target };
};

/** Builds a verified, independently addressable ESM graph from Rollup's exact emitted chunks. */
export const buildCodeGraph = (
	entrypoint: string,
	outputs: ReadonlyArray<EmittedServerChunk>
): Readonly<{
	readonly graph: ArtifactCodeGraph;
	readonly objects: ReadonlyMap<string, Uint8Array>;
}> => {
	const paths = new Set<string>();
	const objects = new Map<string, Uint8Array>();
	const chunks = outputs
		.toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		.map((output): ArtifactCodeChunk => {
			if (paths.has(output.path))
				throw new Error(`Duplicate server code chunk path: ${output.path}`);
			if (output.dynamicImports.length > 0)
				throw new Error(
					`Server code chunk ${output.path} retains unsupported dynamic imports: ${output.dynamicImports.join(', ')}`
				);
			paths.add(output.path);
			const sha256 = digest(output.bytes);
			objects.set(sha256, output.bytes);
			return {
				path: output.path,
				role: output.role,
				sha256,
				byteLength: output.bytes.byteLength,
				imports: output.imports.map((target) => graphImport(output.path, target)),
				dynamicImports: output.dynamicImports.map((target) => graphImport(output.path, target))
			};
		});
	if (!paths.has(entrypoint)) throw new Error(`Server code graph has no entrypoint ${entrypoint}`);
	for (const chunk of chunks) {
		for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
			if (!paths.has(imported.target))
				throw new Error(
					`Server code chunk ${chunk.path} imports missing graph node ${imported.target}`
				);
		}
	}
	const index = {
		format: 'esm-v1',
		entrypoint,
		byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
		chunks
	} as const;
	const sha256 = digest(new TextEncoder().encode(canonicalArtifactCodeGraphIndexEncoding(index)));
	const graph = { ...index, sha256 };
	const refusals = artifactCodeGraphRefusals(graph);
	if (refusals.length > 0)
		throw new Error(`Invalid emitted server code graph: ${refusals.join('; ')}`);
	return { graph, objects };
};

export type TenantReleaseInput = Readonly<{
	readonly protocolVersion: ProtocolVersion;
	readonly artifactId: string;
	readonly artifactVersion: string;
	readonly requiredFacilities: ReadonlyArray<FacilityName>;
	readonly assets: ArtifactAssetIndex;
	readonly schema: Readonly<{
		readonly path: string;
		readonly bytes: Uint8Array;
		/** Compiler-owned logical fingerprint used by O2 and M4. */
		readonly fingerprint: string;
	}>;
	readonly migrations: ReadonlyArray<WorkspaceMigrationEntry>;
	readonly code: Readonly<{
		readonly entrypoint: string;
		readonly chunks: ReadonlyArray<EmittedServerChunk>;
	}>;
	readonly lockfile: Readonly<{ readonly path: string; readonly bytes: Uint8Array }> | undefined;
	readonly toolchain: Readonly<Record<string, string>>;
}>;

export type BuiltTenantRelease = Readonly<{
	readonly release: TenantRelease;
	/** SHA-256 of `manifestBytes`; the immutable release id used by every pointer and publish path. */
	readonly releaseId: string;
	readonly manifestBytes: Uint8Array;
	/** Code, schema, migrations and provenance. Asset objects are emitted by `buildAssetIndex`. */
	readonly objects: ReadonlyMap<string, Uint8Array>;
}>;

/** Builds the complete host-readable release and the immutable objects it newly introduces. */
export const buildTenantRelease = (input: TenantReleaseInput): BuiltTenantRelease => {
	const code = buildCodeGraph(input.code.entrypoint, input.code.chunks);
	const objects = new Map<string, Uint8Array>(code.objects);
	const schemaDescription = input.schema.bytes;
	const migrations = jsonBytes(
		input.migrations.map(({ tag, statements }) => ({ tag, statements: [...statements] }))
	);
	const schemaDescriptionDigest = digest(schemaDescription);
	const migrationsDigest = digest(migrations);
	objects.set(schemaDescriptionDigest, schemaDescription);
	objects.set(migrationsDigest, migrations);
	const lockfile =
		input.lockfile === undefined
			? null
			: {
					path: input.lockfile.path,
					role: 'lockfile' as const,
					sha256: digest(input.lockfile.bytes),
					byteLength: input.lockfile.bytes.byteLength
				};
	if (input.lockfile !== undefined && lockfile !== null)
		objects.set(lockfile.sha256, input.lockfile.bytes);
	const release = {
		formatVersion: 1,
		protocolVersion: input.protocolVersion,
		artifactId: input.artifactId,
		artifactVersion: input.artifactVersion,
		requiredFacilities: [...input.requiredFacilities].toSorted(),
		code: code.graph,
		assets: input.assets,
		schema: {
			fingerprint: input.schema.fingerprint,
			description: {
				path: input.schema.path,
				role: 'schema',
				sha256: schemaDescriptionDigest,
				byteLength: schemaDescription.byteLength
			},
			migrations: {
				path: 'migrations.json',
				role: 'migration-lineage',
				sha256: migrationsDigest,
				byteLength: migrations.byteLength
			}
		},
		provenance: {
			lockfile,
			toolchain: Object.fromEntries(
				Object.entries(input.toolchain).toSorted(([left], [right]) =>
					left < right ? -1 : left > right ? 1 : 0
				)
			)
		}
	} as const satisfies TenantRelease;
	const manifestBytes = new TextEncoder().encode(canonicalTenantReleaseEncoding(release));
	return { release, releaseId: digest(manifestBytes), manifestBytes, objects };
};

/** Writes a release last, after every object it authorizes is present beside it. */
export const writeTenantRelease = async (
	artifactDirectory: string,
	input: TenantReleaseInput
): Promise<BuiltTenantRelease> => {
	const built = buildTenantRelease(input);
	const objectsDirectory = join(artifactDirectory, ARTIFACT_ASSET_DIRECTORY);
	await mkdir(objectsDirectory, { recursive: true });
	for (const [sha256, bytes] of built.objects) {
		await writeFile(join(objectsDirectory, sha256), bytes);
	}
	await writeFile(join(artifactDirectory, ARTIFACT_RELEASE_FILE), built.manifestBytes);
	return built;
};

/** Reads the nearest pnpm lock exactly as provenance, without interpreting or normalising it. */
export const readLockfileProvenance = async (
	workspaceRoot: string
): Promise<TenantReleaseInput['lockfile']> => {
	const path = 'pnpm-lock.yaml';
	try {
		return { path, bytes: await readFile(join(workspaceRoot, path)) };
	} catch (cause) {
		if (typeof cause === 'object' && cause !== null && Reflect.get(cause, 'code') === 'ENOENT')
			return undefined;
		throw cause;
	}
};

/**
 * Reads the latest generated schema snapshot without loading an authored module.
 *
 * A workspace with no snapshot still gets deterministic, compiler-known schema identity from the
 * supplied static descriptor. Neither branch executes guest code.
 */
export const readSchemaProvenance = async (
	workspaceRoot: string,
	migrations: ReadonlyArray<WorkspaceMigrationEntry>,
	fallback: unknown
): Promise<Omit<TenantReleaseInput['schema'], 'fingerprint'>> => {
	const latest = migrations.at(-1);
	if (latest !== undefined) {
		const path = `.norbital/migrations/${latest.tag}/snapshot.json`;
		try {
			return { path, bytes: await readFile(join(workspaceRoot, path)) };
		} catch (cause) {
			if (!(typeof cause === 'object' && cause !== null && Reflect.get(cause, 'code') === 'ENOENT'))
				throw cause;
		}
	}
	return { path: 'compiler-schema.json', bytes: jsonBytes(fallback) };
};
