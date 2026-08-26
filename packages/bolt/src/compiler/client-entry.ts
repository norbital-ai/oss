/**
 * The filename the compiled workspace client is always emitted under.
 *
 * Stable on purpose: a host fetches this module by URL from the artifact it is serving, so a
 * content-hashed name would mean the host had to be told the hash — a second channel carrying a
 * fact the artifact already knows. The chunks it pulls in are hashed as usual; only the door is
 * fixed.
 *
 * It lives here, alone, rather than in `vite-plugin.ts`, because two things need it and only one of
 * them is a Vite plugin: the plugin names the emitted entry, and `sync` refuses to embed a build
 * that did not produce it. Importing the plugin module for a string would drag
 * `@sveltejs/vite-plugin-svelte` and `@tailwindcss/vite` into the CLI's startup for no reason.
 */
export const WORKSPACE_ENTRY_FILE_NAME = 'workspace.js';

/**
 * Public browser paths belong to the selected Bolt tenant namespace on every host.
 *
 * These are origin-independent on purpose: a regional or self-hosted Colony changes the origin,
 * never the tenant URL contract. The Bolt server's private `/_bolt/**` transport is a separate
 * host-to-runtime protocol and must not leak into browser URLs.
 */
export const BOLT_TENANT_PUBLIC_PREFIX = '/__bolt';
export const BOLT_TENANT_STATIC_PREFIX = `${BOLT_TENANT_PUBLIC_PREFIX}/static`;
export const BOLT_TENANT_REQUEST_PREFIX = `${BOLT_TENANT_PUBLIC_PREFIX}/request`;

/**
 * Where a compiled artifact is written, and what its sidecar files are called.
 *
 * The three file names come from `@norbital-ai/bolt-protocol` and are re-exported rather than
 * respelled: `bolt-server` and Colony resolve blobs beside a bundle they were handed and are
 * forbidden from importing this package, so the release layout has to be stated somewhere both
 * halves can read. This module is the compiler's single door onto it.
 *
 * ```text
 * <workspace>/.norbital/artifact/
 * ├── bundle.mjs          the code graph, and only the code graph
 * ├── asset-index.json    { browser: AssetIndexEntry[], server: AssetIndexEntry[] }
 * └── assets/<sha256>     one flat file per distinct digest, extensionless
 * ```
 */
export {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_ASSET_INDEX_FILE,
	ARTIFACT_BUNDLE_FILE
} from '@norbital-ai/bolt-protocol';
export const ARTIFACT_DIRECTORY = '.norbital/artifact';

/**
 * The file the Vite plugin leaves in the client output directory naming what it copied for the server.
 *
 * A workspace declares server assets in its own `vite.config.ts`, which `bolt sync` never reads: it
 * calls `vite build` and Vite loads that config itself. The plugin is therefore the only party that
 * knows the declared list, and the compiler is the only party that can act on it — so the plugin
 * writes the list down where the compiler is already looking.
 *
 * It lives *inside* `.norbital/dist` on purpose. The client build empties that directory, so this
 * file cannot survive a build that did not write it, and a stale declaration — which would silently
 * publish a server-only file or hide a browser one — is not a state the layout can reach. The
 * compiler excludes it from the index by this exact name.
 *
 * Classification is by declared name and nothing else. Path shape is not evidence: `node_modules/`
 * under `dist` looks server-ish and a workspace could legitimately serve a file from there.
 */
export const SERVER_ASSET_DECLARATION_FILE_NAME = '.bolt-server-assets.json';
