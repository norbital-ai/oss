import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';

/** Guard for whether `name` is a collection in the manifest. */
export function isWorkspaceCollectionName(
	manifestCtx: ManifestContext,
	name: string,
	opts?: { throw?: boolean }
): boolean {
	const ok = name in manifestCtx.manifest.collections;
	if (!ok && opts?.throw) {
		throw new Error(`Unknown collection "${name}".`);
	}
	return ok;
}
