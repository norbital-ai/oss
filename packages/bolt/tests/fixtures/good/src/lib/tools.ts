import type { HostToolName } from '../../../../../src/index.ts';

// The host's tools are names from the index (rule 58); an unknown one is a type error.
export const research: readonly HostToolName[] = ['browser_navigate', 'browser_snapshot'];
