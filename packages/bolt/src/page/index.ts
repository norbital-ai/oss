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

/**
 * A page's `ctx`: the typed page operations (`PageBolt`), the page's locale and zone, the viewer's `catalog` (the models
 * and outputs it may read and write), the `device` it runs on, `href` to app pages, the workspace `org`, the agent panel,
 * integration instance controls and the run ledger (`runs`). Its `ui` is what every `@norbital-ai/ui` view takes, so a
 * page passes `ctx` whole (`<Table {ctx} of="projects">`). Nothing else of the shell client is the page's.
 */
export interface PageContext
	extends PageBolt,
		UiContext,
		Pick<ShellBolt, 'locale' | 'tz' | 'catalog' | 'device' | 'href' | 'org' | 'agent' | 'integration' | 'runs'> {}
/**
 * A public page's `ctx`: `PageContext`'s counterpart for apps whose audience is not members, over the public client.
 *
 * The page renders on the server: Svelte renders synchronously, the engine resolves the reads that render used (as the
 * caller, metered by the guest's CPU, heap, crossing and read-byte limits) and renders again with their answers, then
 * the browser hydrates from those answers and the same queries go live. Read initial data with `ctx.query`, filter by
 * `ctx.location` (workspace-relative pathname and search), and start writes and device work on mount. Each route
 * loads only its own browser graph; navigation is a document request.
 */
export interface PublicPageContext
	extends PageBolt,
		UiContext,
		Pick<PublicClient, 'locale' | 'tz' | 'device' | 'href' | 'org' | 'location'> {}

// ui's views are typed by the same names: `of`, `columns`, `values`, `record` and ids per model.
declare module '@norbital-ai/ui' {
	interface Workspace {
		names: ViewNames;
	}
}
