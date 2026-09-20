import { MediaQuery } from 'svelte/reactivity';

/**
 * The one width question a component may ask about its host.
 *
 * Structure branches on width: the sidebar becomes a sheet, a record opens as a page. Behaviour —
 * bottom sheets, hit targets, hover reveals — branches on the pointer, and that lives in
 * `base.css` under `(pointer: coarse)` where no component has to ask. The breakpoint here is the
 * same 48rem the stylesheet restates.
 */
export const narrowViewport = new MediaQuery('max-width: 47.999rem');
