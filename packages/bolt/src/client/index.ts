// `@norbital-ai/bolt/client` (§3.3.10, §3.5): the booted shell client and optional host facilities. `$bolt` is its generated alias
// (`.norbital/bolt.d.ts` for types; the client build resolves the module itself).
// hook:packaging-ui — read on use, never at import: a representation or `lib/` module that imports `$bolt` may load
// before the shell boots.
import type { PageBolt, ViewNames } from '../decl/ctx.ts';
import { bolt as shell, type ShellBolt } from '../shell/runtime.ts';
export { clientFacilities, type ClientFacilities } from './facilities.ts';

/** The shell client typed by the workspace's names: the same rows, inputs and outcomes as `ctx` (§3.5). */
export const bolt = shell as unknown as Omit<ShellBolt, keyof PageBolt> & PageBolt;

// ui's views are typed by the same names (§3.6): `of`, `columns`, `values`, `record` and ids per collection.
declare module '@norbital-ai/ui' {
	interface Workspace { names: ViewNames }
}
