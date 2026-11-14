// The seam between a page and the host's Studio. Studio is no part of a workspace's build: a Studio host serves it as
// one self-contained ES module (Bolt's `ShellBoot.studio_bundle`) with its own Svelte, ui and Effect, sharing no module
// with the page, so all that crosses is plain values.
import { Predicate } from 'effect';
import type { StudioTab } from '@norbital-ai/host-api';
import type { UiTextKey } from '../primitives/index.js';

/** The plain values the shell hands a host's Studio bundle: copy, locale, the open tab and file, and navigation callbacks. */
export type StudioProps = {
	/** The shell's copy: the workspace's messages, then the framework's. A key it lacks comes back unchanged. */
	readonly t: (key: string) => string;
	readonly locale: string;
	/** ui's chrome strings in that locale. */
	readonly ui_text: { readonly [key in UiTextKey]?: string };
	readonly tab: StudioTab;
	readonly on_tab: (tab: StudioTab) => void;
	/** The file the URL names. */
	readonly file: string | null;
	readonly on_file: (path: string) => void;
	readonly admin: boolean;
	/** Hands a request to Norbius and sends it; `null` where the viewer has no Norbius. */
	readonly on_ask: ((prompt: string) => void) | null;
	/** A host's own authenticated endpoint for the Studio routes; absent: the workspace's. */
	readonly base?: string;
};
/** A mounted Studio: `update` carries a moved URL in without a remount, so unsaved edits survive a back navigation. */
export type StudioMount = {
	update(props: StudioProps): void;
	unmount(): Promise<void>;
};
/** Adapt an untrusted bundle at its owning boundary; a function alone does not prove the mounted contract. */
export function mount_studio(module: unknown, target: HTMLElement, props: StudioProps): StudioMount {
	if (!Predicate.isObject(module) || typeof module['mount_studio'] !== 'function')
		throw new Error('The Studio bundle exports no mount_studio.');
	const mounted: unknown = module['mount_studio'].call(module, target, props);
	if (
		!Predicate.isObject(mounted) ||
		typeof mounted['update'] !== 'function' ||
		typeof mounted['unmount'] !== 'function'
	)
		throw new Error('The Studio bundle returned an invalid mounted view.');
	const update = mounted['update'],
		unmount = mounted['unmount'];
	return {
		update(next) {
			const result: unknown = update.call(mounted, next);
			if (result !== undefined) throw new Error('Studio update must return no value.');
		},
		async unmount() {
			const result: unknown = await unmount.call(mounted);
			if (result !== undefined) throw new Error('Studio unmount must return no value.');
		}
	};
}
