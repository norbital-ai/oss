/** Native Studio for a host's authenticated control surface, independent of tenant page code. */
export { default as Studio } from '../shell/studio/Studio.svelte';
/** The native, Schema-decoded shell transport; `base` selects the host's authenticated endpoint. */
export { shellApi } from '../shell/runtime.ts';
export type { StudioTab } from '../shell/nav.ts';
