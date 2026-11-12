import type { EngineActor } from '../contracts.ts';

/** Native attribution columns name members, anonymous visitors and an envoy's linked member. */
export const actor_id = (a: EngineActor): string | null =>
	a.kind === 'member' ? a.id : a.kind === 'envoy' ? a.member : a.kind === 'visitor' && a.anonymous === true ? a.visitor : null;

/** History's actor: `<kind>:<id>`. */
export const actor_ref = (a: EngineActor): string =>
	`${a.kind}:${a.kind === 'member' ? a.id : a.kind === 'system' ? a.run : a.kind === 'api_key' ? a.key : a.kind === 'visitor' ? a.visitor : a.sender}`;
