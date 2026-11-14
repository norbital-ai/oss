// The calls every release answers before a host activates it, and what a host hands over for a release. Plain
// Promise + AbortSignal; answers are Schema-encoded JSON this package decodes.
import type { ReleaseFacts } from './answers.ts';

/** The abort signal every call takes. */
export type Signal = { readonly signal: AbortSignal };
/** A release path's kind and byte size. */
export type ArtifactStat = { readonly kind: 'file' | 'directory'; readonly size: number };
/**
 * The release's files, read-only. Paths are posix and relative to the release directory (`artifact.json`,
 * `client/index.html`), with no `.`, empty, `\` or NUL segment; `..` only as `../seed/<pack>/…`, the build's seed packs
 * beside the release (`.norbital/bundle` + `.norbital/seed/<pack>`), or `../docs/<file>`, the API reference of the Bolt
 * release it pins (`build/docs/<file>`, for the agent's `docs` tool). The host refuses any other path and resolves
 * symlinks itself, so a path never leaves those roots. `stat` answers `null` for nothing there; `list` answers every
 * file (never a directory) under `dir`, recursively, relative to `dir`, sorted.
 */
export interface ArtifactPort {
	read(path: string, signal: AbortSignal): Promise<Uint8Array>;
	list(dir: string, signal: AbortSignal): Promise<readonly string[]>;
	stat(path: string, signal: AbortSignal): Promise<ArtifactStat | null>;
}
/** A built workspace: `bolt build`'s release, with source, format and digests verified by this release. */
export type Release = {
	/** The host's release id (the artifact digest it records): authorities are compiled per release. */
	readonly id: string;
	/** The release's files (`artifact.json`, `client/…`) and its seed packs (`../seed/<pack>/…`), read-only. */
	readonly artifact: ArtifactPort;
};
/**
 * What every release answers, whatever its Bolt: the version and contract a host admits it by, its cookies, and the
 * static calls over a release. A release's full `HostApi` extends it.
 */
export type HostApiCore = {
	/** Hosts admit only runtimes that evaluate tenant source without restoring native snapshots. */
	readonly guest_execution: 'source';
	/** The HOST_API the release speaks. */
	readonly version: number;
	/** The artifact contract this release implements. */
	readonly contract: string;
	readonly cookies: { readonly session: string; readonly preview: string };
	/** The session cookie's site attributes. */
	cookie_site(secure: boolean): string;
	/** Refuses an artifact this release did not build or whose files do not match their digests. */
	verify(release: Release, options: Signal): Promise<void>;
	/** What the release says about itself, decoded by its own Bolt (`ReleaseFacts`). */
	describe(release: Release, options: Signal): Promise<ReleaseFacts>;
	/** The client page's `frame-ancestors` policy for `path`. */
	frame_policy(release: Release, path: string, options: Signal): Promise<string>;
};
