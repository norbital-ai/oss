/**
 * What the orb says, in the three states a reader can actually act on: nothing is happening,
 * something is, or something broke.
 *
 * The union lives beside the component rather than in the Bolt agent runtime because the orb is
 * now a shared primitive — the marketing site renders one to stand for AI without importing a
 * transcript projector. Bolt re-exports it as `AgentOrbState` from `agent-orb-state.ts`, which
 * keeps the runtime's own vocabulary intact.
 */
export type ThinkingOrbState = 'ready' | 'working' | 'error';
