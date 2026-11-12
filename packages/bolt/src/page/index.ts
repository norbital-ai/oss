// Page types and standalone helpers. The shell hands each component its own context.
import type { ViewNames } from '../decl/ctx.ts';
import type { PageBolt } from './page-bolt.ts';
import type { ShellBolt } from '../shell/runtime.ts';
import type { PublicClient } from '../shell/public/client.ts';
import type { UiContext } from '@norbital-ai/ui';
export type { PageBolt } from './page-bolt.ts';
export type { PageSnapshotHost } from './bolt.ts';
export { file_ref } from './file-ref.ts';
export { default as IntegrationSetup } from './IntegrationSetup.svelte';
export type { IntegrationSetupEntry } from '../shell/integration/setup.ts';

/** A page's `ctx`; its `ui` is what every `@norbital-ai/ui` view takes, so a page passes `ctx` whole (`<Table {ctx} of="projects">`). */
export type PageContext = Omit<ShellBolt, keyof PageBolt | 'native_query' | 'observe' | 'closed' | 'sync'> & PageBolt & UiContext;
export type PublicPageContext = Omit<PublicClient, keyof PageBolt | 'native_query' | 'observe' | 'closed' | 'sync'> & PageBolt & UiContext;

// ui's views are typed by the same names (§3.6): `of`, `columns`, `values`, `record` and ids per model.
declare module '@norbital-ai/ui' {
	interface Workspace {
		names: ViewNames;
	}
}
