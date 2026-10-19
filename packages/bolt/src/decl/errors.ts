// `@norbital-ai/bolt/errors` (D3): canonical tagged errors shared by guest bodies, pages and the test kit.
// The guest loads a family only when an operation needs it; these reexports retain the public class identities.
export { Refusal } from './errors/refusal.ts';
export { ActRefused, ActConflict, ActUnknown, actFailure, type ActFailure } from './errors/act.ts';
export {
	FACILITY_KINDS,
	FacilityFailure,
	Unavailable,
	facilityFailure
} from './errors/facility.ts';
export { ReadFailed } from './errors/read.ts';
export { TransportFailed, ProtocolFailed, DescribeTimeout } from './errors/browser.ts';
