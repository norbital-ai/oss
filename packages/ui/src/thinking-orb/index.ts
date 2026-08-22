import { Schema } from 'effect';
import Root from './thinking-orb.svelte';

export {
	Root,
	//
	Root as ThinkingOrb
};
/** What the orb says, in the three states a reader can actually act on: nothing is happening,
 * something is, or something broke.
 *
 * The union lives beside the component rather than in the Bolt agent runtime because the orb is
 * now a shared primitive — the marketing site renders one to stand for AI without importing a
 * transcript projector. Bolt re-exports it as `AgentOrbState` from `agent-orb-state.ts`, which
 * keeps the runtime's own vocabulary intact.
 */
export const ThinkingOrbStateSchema = Schema.Literals(['ready', 'working', 'error']);
export type ThinkingOrbState = typeof ThinkingOrbStateSchema.Type;
