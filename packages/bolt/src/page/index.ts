// `@norbital-ai/bolt/page` (§3.3.10, §3.5, D9): the booted shell client, the ui edge it runs on, and optional host
// device. `$bolt` is its generated alias (`.norbital/bolt.d.ts` for types; the client build resolves the module itself),
// exporting `bolt, run, fork, attach`. Reads are `bolt.query` (a `Query<T>`, live where a component reads it).
// hook:packaging-ui — read on use, never at import: a representation or `lib/` module that imports `$bolt` may load
// before the shell boots.
import type { ViewNames } from '../decl/ctx.ts';
import type { PageBolt } from './page-bolt.ts';
import { bolt as shell, type ShellBolt } from '../shell/runtime.ts';
export { attach, fork, run } from '@norbital-ai/ui/effect';
export type { PageAct, PageBolt, PageCall, PageClock, PageStart, Query } from './page-bolt.ts';
export { resolveDevice, type DeviceApi } from './device.ts';
export { fileRef } from './file-ref.ts';
export { frameworkText } from '../shell/i18n.ts';

/** The shell client typed by the workspace's names: the same rows, inputs and outcomes as `ctx` (§3.5). */
export const bolt: Omit<ShellBolt, keyof PageBolt> & PageBolt = shell as ShellBolt & PageBolt;

// ui's views are typed by the same names (§3.6): `of`, `columns`, `values`, `record` and ids per model.
declare module '@norbital-ai/ui' {
	interface Workspace {
		names: ViewNames;
	}
}
