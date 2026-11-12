// Page types and standalone helpers. The shell hands each component its own context.
import type { ViewNames } from '../decl/ctx.ts';
import type { PageBolt } from './page-bolt.ts';
import type { ShellBolt } from '../shell/runtime.ts';
import type { PublicClient } from '../shell/public/client.ts';
export type { PageAct, PageBolt, PageCall, PageClock, PageRun, Query } from './page-bolt.ts';
export type { PageSnapshotHost } from './bolt.ts';
export { resolve_device, type DeviceApi } from './device.ts';
export { file_ref } from './file-ref.ts';
export { framework_text } from '../shell/i18n.ts';

export type PageContext = Omit<ShellBolt, keyof PageBolt | 'native_query' | 'observe' | 'closed' | 'sync'> & PageBolt;
export type PublicPageContext = Omit<PublicClient, keyof PageBolt | 'native_query' | 'observe' | 'closed' | 'sync'> & PageBolt;

// ui's views are typed by the same names (§3.6): `of`, `columns`, `values`, `record` and ids per model.
declare module '@norbital-ai/ui' {
	interface Workspace {
		names: ViewNames;
	}
}
