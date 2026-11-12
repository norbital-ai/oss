// Mounting the workspace shell in the browser (§5.10). The build hands it the app and group literals (routes are
// resolved client-side), one lazy chunk per page (`'<app>/<page>'`), and the components other areas own: the agent's
// conversation, each model's representation, each integration definition's setup and each custom field's renderer.
import { mount, unmount, type Component } from 'svelte';
import type { CustomFieldEntry, RepresentationLoader } from '@norbital-ai/ui';
import type { BoltConfig } from '../page/bolt.ts';
import type { IntegrationSetupEntry } from '../page/integration.ts';
import { await_device, resolve_device, type DeviceApi } from '../page/device.ts';
import type { ShellManifest } from './nav.ts';
import type { AgentRequest, ShellBolt, ShellPageContext } from './runtime.ts';
import Shell from './Shell.svelte';
import { Effect, ManagedRuntime, Result, Schema } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { ShellLive } from './runtime.ts';

const InitialModules = Schema.Struct({
	css: Schema.Array(Schema.String),
	native_modules: Schema.Array(Schema.String)
});
export const INITIAL_MODULES_ID = 'bolt-initial-modules';

/** The browser waits for shell styles; the native app also warms the workspace's main-thread modules. */
export const initialize_shell_assets = (entry: string): Promise<void> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const text = document.getElementById(INITIAL_MODULES_ID)?.textContent;
			if (text === undefined || text === null)
				return yield* Effect.fail(new Error('Initial workspace module list is missing.'));
			const assets = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InitialModules))(text);
			const base = new URL('../', entry);
			const resolve = (path: string) => {
				const url = new URL(path, base);
				if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
					throw new Error('Initial workspace asset is outside this release.');
				return url.href;
			};
			yield* Effect.all(
				[
					Effect.gen(function* () {
						yield* Effect.tryPromise(await_device);
						const { platform } = resolve_device();
						if (platform !== 'ios' && platform !== 'android') return;
						yield* Effect.forEach(
							assets.native_modules,
							(path) =>
								Effect.tryPromise(async () => {
									await import(/* @vite-ignore */ resolve(path));
								}),
							{ concurrency: 'unbounded', discard: true }
						);
					}),
					Effect.forEach(
						assets.css,
						(path) =>
							Effect.gen(function* () {
								const href = yield* Effect.try(() => resolve(path));
								const existing = [
									...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
								].find((link) => link.href === href);
								if (existing !== undefined && existing.sheet !== null) return;
								yield* Effect.callback<void, Error>((resume) => {
									const link = document.createElement('link');
									const loaded = () => resume(Effect.void);
									const failed = () =>
										resume(Effect.fail(new Error(`Workspace stylesheet failed to load: ${href}`)));
									link.addEventListener('load', loaded, { once: true });
									link.addEventListener('error', failed, { once: true });
									link.rel = 'stylesheet';
									link.href = href;
									document.head.append(link);
									return Effect.sync(() => {
										link.removeEventListener('load', loaded);
										link.removeEventListener('error', failed);
									});
								});
							}),
						{ concurrency: 'unbounded', discard: true }
					)
				],
				{ concurrency: 'unbounded', discard: true }
			);
		})
	);

/** Browser shell configuration, including optional Device supplied by its host. */
export type ShellMountConfig = {
	manifest: ShellManifest;
	/** The artifact's display name, available before the caller's boot response arrives. */
	workspace_name?: string;
	/** Shell styles and, in the native app, device and module readiness before mounting. */
	ready?: Promise<void>;
	/** Server-rendered routes use a document navigation to admit and load the new public page. */
	public_routes?: readonly string[];
	/** `'<app>/<page>'` (apps) and `'kiosk/<kiosk>/<page>'` (kiosks) → the page chunk. */
	pages: { readonly [page: string]: () => Promise<{ default: Component<{ ctx: ShellPageContext }> }> };
	/** App session components stay mounted across navigation for signed-in callers with access to that app. */
	sessions?: { readonly [app: string]: Component<{ ctx: ShellBolt }> };
	messages?: { readonly [key: string]: string };
	agent?: Component<{ bolt: ShellBolt; request: AgentRequest; on_close: () => void }>;
	/** Each model's `+representation.svelte`, loaded on first use; every `RecordShell` (sheet or page) reads it. */
	representations?: { readonly [model: string]: RepresentationLoader };
	/** Named integration setup components, loaded when their authorized instance is opened. */
	integration_setups?: { readonly [integration: string]: IntegrationSetupEntry };
	/** The workspace's custom fields: their shape, and the `+renderer.svelte` that shows and edits them. */
	custom_fields?: { readonly [field: string]: CustomFieldEntry };
	fetch?: typeof fetch;
	/** Optional Device from the embedding host; otherwise the native shell's injected Device or the browser's are used. */
	device?: DeviceApi;
	/** The live stream's source; default the browser's `EventSource` (tests and `sweep()` give their own). */
	open_stream?: BoltConfig['open_stream'];
};

/** Mounts the workspace browser shell with optional Device supplied by its embedding host. */
export function mount_shell(target: HTMLElement, config: ShellMountConfig): () => Promise<void> {
	const dispose = mount_edge(ManagedRuntime.make(ShellLive(config)));
	const view = mount(Shell, { target, props: { config } });
	return () => {
		const started = Result.try(() => unmount(view));
		const finished = Result.isFailure(started)
			? Promise.resolve(Result.fail(started.failure))
			: started.success.then(Result.succeed, (error: unknown) => Result.fail(error));
		return finished.then(async (unmounted) => {
			await dispose();
			Result.getOrThrow(unmounted);
		});
	};
}
