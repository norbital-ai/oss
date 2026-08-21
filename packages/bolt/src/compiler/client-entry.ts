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
