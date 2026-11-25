// Portal target context and DOM attachment: teleports floating surfaces (popovers, tooltips,
// dialogs) into the configured host root (default `document.body`) so styles and z-index layers
// stay scoped when mounted inside a shadow/isolated container such as Studio.
import { getContext, setContext } from 'svelte';
import type { Attachment } from 'svelte/attachments';

const PORTAL_TARGET = Symbol.for('norbital.ui.portal.target');

/** Target element, CSS selector or `null` to disable teleporting and render in place. */
export type PortalTarget = HTMLElement | string | null | undefined;

/** Options object accepted by `portal(...)`. */
export type PortalOptions = {
	/** Mount element, CSS selector, or `null` to render in place. */
	readonly to?: PortalTarget;
	/** When `true`, keeps the element in place instead of teleporting it. */
	readonly disabled?: boolean;
};

type PortalGetter = () => PortalTarget;

/** Sets the default portal mount target for every descendant overlay. */
export function set_portal_target(target: PortalTarget | PortalGetter): void {
	const getter: PortalGetter = typeof target === 'function' ? target : () => target;
	setContext(PORTAL_TARGET, getter);
}

/** Reads the inherited portal target from context, if configured. */
export function get_portal_target(): PortalTarget {
	const getter = getContext<PortalGetter | undefined>(PORTAL_TARGET);
	return getter ? getter() : undefined;
}

function isPortalOptions(value: PortalTarget | PortalOptions): value is PortalOptions {
	return (
		typeof value === 'object' &&
		value !== null &&
		!(typeof HTMLElement !== 'undefined' && value instanceof HTMLElement)
	);
}

function resolveTarget(explicit: PortalTarget, inherited: PortalTarget): HTMLElement | null {
	const chosen = explicit !== undefined ? explicit : inherited;
	if (chosen === null) return null;
	if (typeof document === 'undefined') return null;
	if (chosen === undefined) return document.body;
	if (typeof chosen === 'string') return document.querySelector<HTMLElement>(chosen) ?? document.body;
	return chosen;
}

/**
 * Svelte attachment that moves the element into the resolved portal container while mounted and
 * restores or removes it cleanly on teardown.
 */
export function portal(target?: PortalTarget | PortalOptions): Attachment<HTMLElement> {
	const inherited = get_portal_target();
	const opts = isPortalOptions(target) ? target : { to: target, disabled: false };
	return (el) => {
		if (opts.disabled) return;
		const host = resolveTarget(opts.to, inherited);
		if (host === null || el.parentElement === host) return;
		// The marker holds the element's place. A teardown that finds it gone is the owner unmounting: its nodes
		// were removed already, so the element goes too instead of returning to a parent that outlived it.
		const marker = document.createComment('');
		el.before(marker);
		host.appendChild(el);
		return () => {
			if (marker.isConnected && el.parentElement === host) marker.replaceWith(el);
			else {
				marker.remove();
				if (el.parentElement === host) el.remove();
			}
		};
	};
}
