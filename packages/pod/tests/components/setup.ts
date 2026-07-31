import { afterEach } from 'vitest';

/**
 * happy-dom implements the DOM, not a rendering engine.
 *
 * `ResizeObserver` is the one omission these surfaces actually hit: the sidebar and the popover are
 * built on floating-ui, which observes its anchor. A no-op is the honest stand-in — there is no
 * layout to observe here, so an observer that never fires reports exactly as much as this
 * environment knows.
 */
if (!('ResizeObserver' in globalThis)) {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
}

afterEach(() => {
	document.body.replaceChildren();
});
