// `@norbital-ai/bolt/errors` (D3): canonical tagged errors shared by guest bodies, pages and the test kit.
// The guest loads a family only when an operation needs it; these reexports retain the public class identities.
export type { Refusal } from './errors/refusal.ts';
export { ActRefused, ActConflict, type ActFailure } from './errors/act.ts';
export { FacilityFailure, Unavailable } from '@norbital-ai/host-api';
export { ReadFailed } from './errors/read.ts';
export { ProtocolFailed } from './errors/browser.ts';
