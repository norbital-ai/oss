// `@norbital-ai/bolt/tooling/browser`: what bolt-cli's browser test kit (`@norbital-ai/bolt-cli/test/browser`) mounts and
// reads: the shell and its wire. First-party tooling only, loaded under Vite (the shell is Svelte).
export { type Json } from '../decl/values.ts';
export { type Holder } from '../engine/access/authority.ts';
export { type Authority } from '../engine/contracts.ts';
export { teams } from '../engine/manifest.ts';
export { type EventSourceLike } from '../page/stream.ts';
export { renderMode } from '../protocol/pages.ts';
export { PUBLIC_HYDRATION_ID, decodePublicHydration } from '../protocol/public-page.ts';
export { Frame, LiveReply, QReply } from '../protocol/schema.ts';
export { PATHS } from '../protocol/wire.ts';
export { mountShell, type ShellMountConfig } from '../shell/mount.ts';
export { audienceOf, nav, surfaces, type NavNode } from '../shell/nav.ts';
