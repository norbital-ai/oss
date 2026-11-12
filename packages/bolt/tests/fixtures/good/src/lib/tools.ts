
import type { HostToolName } from '../../../../../src/decl/names.ts';

// The host's tools are names from the index; an unknown one is a type error.
export const research: readonly HostToolName[] = ['browser_navigate', 'browser_snapshot'];
