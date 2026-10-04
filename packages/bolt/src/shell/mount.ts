// Mounting the workspace shell in the browser (§5.10). The build hands it the app and group literals (routes are
// resolved client-side), one lazy chunk per page (`'<app>/<page>'`), and the components other areas own: the agent's
// conversation, each collection's representation, each channel's connection and each custom field's renderer.
import { mount, type Component } from 'svelte';
import type { BoltConfig } from '../client/bolt.ts';
import type { ClientFacilities } from '../client/facilities.ts';
import type { ShellManifest } from './nav.ts';
import type { AgentRequest, CustomFieldView, RecordView, ShellBolt } from './runtime.ts';
import Shell from './Shell.svelte';
import type { ConnectLoader, ConnectProps } from './channels/connect.ts';

/** Browser shell configuration, including optional facilities supplied by its host. */
export type ShellMountConfig = {
	manifest: ShellManifest;
	/** `'<app>/<page>'` → the page chunk; a visitor page loads only its own app's chunks. */
	pages: { readonly [page: string]: () => Promise<{ default: Component }> };
	/** App session components stay mounted across navigation for signed-in callers with access to that app. */
	sessions?: { readonly [app: string]: Component };
	messages?: { readonly [key: string]: string };
	agent?: Component<{ bolt: ShellBolt; request: AgentRequest; onClose: () => void }>;
	/** Each collection's `+representation.svelte`, loaded on first use; every `RecordShell` (sheet or page) reads it. */
	representations?: { readonly [collection: string]: () => Promise<{ default: Component<{ view: RecordView }> }> };
	/**
	 * Each `custom` channel's `+*.connect.svelte`, by channel name, loaded on first use. Every other channel is drawn from
	 * its provider's setup description, which the host publishes.
	 */
	connects?: { readonly [channel: string]: ConnectLoader };
	/** The workspace's custom fields: their shape, and the `+renderer.svelte` that shows and edits them. */
	customFields?: { readonly [field: string]: { shape: never; label?: string; renderer?: Component<{ view: CustomFieldView }> } };
	fetch?: typeof fetch;
	/** Optional embedding host facilities; otherwise native host injection or browser facilities are detected. */
	facilities?: ClientFacilities;
	/** The live stream's source; default the browser's `EventSource` (tests and `sweep()` give their own). */
	openStream?: BoltConfig['openStream'];
};

/** What a connect component is given: the connection, the host's verbs, and the page's `t`. */
export type { ConnectProps };

/** Mounts the workspace browser shell with optional facilities supplied by its embedding host. */
export function mountShell(target: HTMLElement, config: ShellMountConfig) {
	return mount(Shell, { target, props: { config } });
}
