// The seam between the shell and the host's Studio. Studio is no part of a workspace's build: a Studio host serves it as
// one self-contained ES module (`ShellBoot.studioBundle`) with its own Svelte, ui and Effect, sharing no module with the
// page, so all that crosses is plain values. Each pinned release mounts this interface for as long as it serves: extend
// it, never change a member.
import type { UiTextKey } from '@norbital-ai/ui';
import type { StudioTab } from '../nav.ts';

export type StudioProps = {
	/** The shell's copy: the workspace's messages, then the framework's. A key it lacks comes back unchanged. */
	readonly t: (key: string) => string;
	readonly locale: string;
	/** ui's chrome strings in that locale. */
	readonly uiText: { readonly [key in UiTextKey]?: string };
	readonly tab: StudioTab;
	readonly onTab: (tab: StudioTab) => void;
	/** The file the URL names. */
	readonly file: string | null;
	readonly onFile: (path: string) => void;
	readonly admin: boolean;
	/** Hands a request to Norbius and sends it; `null` where the viewer has no Norbius. */
	readonly onAsk: ((prompt: string) => void) | null;
	/** A host's own authenticated endpoint for the Studio routes; absent: the workspace's. */
	readonly base?: string;
};
/** A mounted Studio: `update` carries a moved URL in without a remount, so unsaved edits survive a back navigation. */
export type StudioMount = {
	update(props: StudioProps): void;
	unmount(): Promise<void>;
};
export type MountStudio = (target: HTMLElement, props: StudioProps) => StudioMount;
/** The bundle's one export. */
export const isMountStudio = (value: unknown): value is MountStudio =>
	typeof value === 'function';
