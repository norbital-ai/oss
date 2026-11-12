import type { UiContext } from '../src/client/contract.ts';
import type { KindsHost } from '../src/kinds/context.ts';
/** A page context with no view client: what a controlled local view or a standalone input renders under. */
export const bare_ctx = (kinds: KindsHost = {}): UiContext => ({ ui: { kinds } });
