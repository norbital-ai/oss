/** Cache namespace for the filesystem-authored Vite checkpoint contract. */
export const CHECKPOINT_BUILD_FORMAT = 'vite-2';
export const LEGACY_CHECKPOINT_BUILD_FORMAT = 'vite-1';

const PLATFORM_PACKAGE_KEY_PATTERN = /^[0-9a-f]{16}$/;
const PLATFORM_BUILD_CONTRACT_ID_PATTERN = /^[0-9a-f]{64}$/;

function assertPlatformPackageKey(packageKey: string): void {
	if (!PLATFORM_PACKAGE_KEY_PATTERN.test(packageKey)) {
		throw new Error(`Invalid platform package key: ${packageKey}`);
	}
}

function assertPlatformBuildContractId(buildContractId: string): void {
	if (!PLATFORM_BUILD_CONTRACT_ID_PATTERN.test(buildContractId)) {
		throw new Error(`Invalid platform build contract id: ${buildContractId}`);
	}
}

export type CheckpointBuildIdentity =
	| {
			readonly format: typeof CHECKPOINT_BUILD_FORMAT;
			readonly buildContractId: string;
	  }
	| {
			readonly format: typeof LEGACY_CHECKPOINT_BUILD_FORMAT;
			readonly packageKey: string;
	  };

/** Exact builder namespace for one immutable package and OCI build contract. */
export function checkpointBuilderVersion(buildContractId: string): string {
	assertPlatformBuildContractId(buildContractId);
	return `${CHECKPOINT_BUILD_FORMAT}-${buildContractId}`;
}

/** Parse current checkpoints and retained package-only `vite-1` checkpoints. */
export function parseCheckpointBuilderVersion(builderVersion: string): CheckpointBuildIdentity {
	const currentPrefix = `${CHECKPOINT_BUILD_FORMAT}-`;
	if (builderVersion.startsWith(currentPrefix)) {
		const buildContractId = builderVersion.slice(currentPrefix.length);
		assertPlatformBuildContractId(buildContractId);
		return { format: CHECKPOINT_BUILD_FORMAT, buildContractId };
	}
	const legacyPrefix = `${LEGACY_CHECKPOINT_BUILD_FORMAT}-`;
	if (builderVersion.startsWith(legacyPrefix)) {
		const packageKey = builderVersion.slice(legacyPrefix.length);
		assertPlatformPackageKey(packageKey);
		return { format: LEGACY_CHECKPOINT_BUILD_FORMAT, packageKey };
	}
	throw new Error(`Invalid checkpoint builder version: ${builderVersion}`);
}

/** Extract the immutable build contract from a current checkpoint namespace. */
export function checkpointBuildContractId(builderVersion: string): string {
	const identity = parseCheckpointBuilderVersion(builderVersion);
	if (identity.format !== CHECKPOINT_BUILD_FORMAT) {
		throw new Error(`Legacy checkpoint has no platform build contract: ${builderVersion}`);
	}
	return identity.buildContractId;
}

/** Extract the package key from a retained `vite-1` checkpoint namespace. */
export function checkpointPackageKey(builderVersion: string): string {
	const identity = parseCheckpointBuilderVersion(builderVersion);
	if (identity.format !== LEGACY_CHECKPOINT_BUILD_FORMAT) {
		throw new Error(
			`Current checkpoint package key must be read from its platform release: ${builderVersion}`
		);
	}
	return identity.packageKey;
}

/** Bundle-root file holding the precomputed NorbitalManifest projection. */
export const CHECKPOINT_MANIFEST_FILENAME = 'manifest.json';

/**
 * Bundle-root entry point the tenant container executes. `.mjs` so it needs no `package.json`
 * of its own at the bundle root.
 */
export const SERVE_ENTRY_FILENAME = 'serve.mjs';

export const CHECKPOINT_BUILD_REQUIRED_PATHS = [
	CHECKPOINT_MANIFEST_FILENAME,
	'dist/index.html',
	SERVE_ENTRY_FILENAME,
	'output/server/index.js',
	'schema-functions.sql',
	'schema-post-ddl.sql'
] as const;

/** Content-Type for a checkpoint static asset based on its file extension. */
export function staticAssetContentType(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
	switch (extension) {
		case '.css':
			return 'text/css; charset=utf-8';
		case '.gif':
			return 'image/gif';
		// Core serves the SPA shell itself, so an unmapped `.html` would make a browser download
		// the workspace instead of rendering it.
		case '.html':
			return 'text/html; charset=utf-8';
		case '.ico':
			return 'image/x-icon';
		case '.jpeg':
		case '.jpg':
			return 'image/jpeg';
		case '.js':
			return 'text/javascript; charset=utf-8';
		case '.json':
		case '.map':
			return 'application/json';
		case '.png':
			return 'image/png';
		case '.svg':
			return 'image/svg+xml';
		case '.txt':
			return 'text/plain';
		case '.wasm':
			return 'application/wasm';
		case '.webp':
			return 'image/webp';
		case '.woff':
			return 'font/woff';
		case '.woff2':
			return 'font/woff2';
		default:
			return 'application/octet-stream';
	}
}
