import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
	HostFileStorageBinding,
	PresignResult
} from '@norbital-ai/platform-utils/runtime/binding';

/** The route `pod start` serves presigned objects from. */
export const STORAGE_ROUTE_PREFIX = '/_pod/storage/';

export type LocalFileStorageOptions = {
	/** Directory that holds the objects. Relative paths resolve against the workspace root. */
	readonly directory: string;
	/** Public origin used to build presigned URLs, e.g. `http://127.0.0.1:5173`. */
	readonly origin: string;
	/** HMAC key for presigned URLs. Generated per process when omitted. */
	readonly signingKey?: string;
};

export type LocalFileStorage = HostFileStorageBinding & {
	/**
	 * Resolve a presigned request to bytes, or `null` when the signature is absent, wrong, or
	 * expired. The standalone server calls this; nothing else should need it.
	 */
	resolvePresigned(url: URL): Promise<{ body: Buffer; key: string } | null>;
};

/**
 * Object keys come from the runtime (`document-assets/<uuid><ext>`), not from a user, but they are
 * still concatenated into a filesystem path — so they are validated rather than trusted. A key
 * that escapes the storage directory is a bug in the runtime, and it should fail loudly here
 * rather than write outside it.
 */
function objectPath(root: string, key: string): string {
	const candidate = path.normalize(path.join(root, key));
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Workspace file storage key escapes the storage root: ${key}`);
	}
	return candidate;
}

function sign(signingKey: string, key: string, expiresAt: number, method: 'GET' | 'PUT'): string {
	return createHmac('sha256', signingKey)
		.update(`${method}\n${key}\n${expiresAt}`)
		.digest('base64url');
}

function signatureMatches(expected: string, provided: string): boolean {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const providedBytes = Buffer.from(provided, 'utf8');
	return (
		expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
	);
}

/**
 * File storage backed by the local filesystem.
 *
 * This is the standalone counterpart to Core's object store. It is deliberately the simplest thing
 * that satisfies the contract: one file per key, no metadata sidecar, no lifecycle. Content type
 * is not persisted because the runtime already stores it on the `document_asset` record and never
 * asks storage for it.
 */
export function localFileStorage(options: LocalFileStorageOptions): LocalFileStorage {
	const root = path.resolve(options.directory);
	const origin = options.origin.replace(/\/+$/, '');
	// A generated key means presigned URLs do not survive a restart. That is correct for a
	// development host: a URL minted by a process that is gone should not still be redeemable.
	const signingKey = options.signingKey ?? randomBytes(32).toString('base64url');

	const presign = (key: string, ttlSeconds: number, method: 'GET' | 'PUT'): PresignResult => {
		const expiresAtMs = Date.now() + ttlSeconds * 1000;
		const signature = sign(signingKey, key, expiresAtMs, method);
		const url = new URL(`${origin}${STORAGE_ROUTE_PREFIX}${key}`);
		url.searchParams.set('exp', String(expiresAtMs));
		url.searchParams.set('sig', signature);
		return { url: url.toString(), expiresAt: new Date(expiresAtMs).toISOString() };
	};

	return {
		async put(key, body) {
			const target = objectPath(root, key);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, body);
		},
		async get(key) {
			try {
				return new Uint8Array(await readFile(objectPath(root, key)));
			} catch (cause) {
				if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null;
				throw cause;
			}
		},
		async delete(key) {
			await rm(objectPath(root, key), { force: true });
		},
		presignPut(key, ttlSeconds) {
			return Promise.resolve(presign(key, ttlSeconds, 'PUT'));
		},
		presignGet(key, ttlSeconds) {
			return Promise.resolve(presign(key, ttlSeconds, 'GET'));
		},
		async resolvePresigned(url) {
			const key = decodeURIComponent(url.pathname.slice(STORAGE_ROUTE_PREFIX.length));
			const expiresAt = Number(url.searchParams.get('exp'));
			const signature = url.searchParams.get('sig') ?? '';
			if (!key || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
			if (!signatureMatches(sign(signingKey, key, expiresAt, 'GET'), signature)) return null;
			try {
				return { body: await readFile(objectPath(root, key)), key };
			} catch (cause) {
				if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null;
				throw cause;
			}
		}
	};
}
