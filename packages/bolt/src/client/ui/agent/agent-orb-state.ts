import { toPanelMessages } from './transcript.js';

/**
 * What the orb says, in the three states a reader can actually act on.
 *
 * It used to carry six — idle, thinking, searching, authoring, working, failed — which asked the
 * animation to distinguish "searching" from "authoring" at 20 pixels, and asked the runtime to
 * report which of them was true. Neither held up: the shapes read the same at that size, and the
 * runtime only ever knows whether a turn is running. Three states each mean something different to
 * the person watching: nothing is happening, something is, or something broke.
 */
export type AgentOrbState = 'ready' | 'working' | 'error';

export type AgentOrbStatusKey =
	'bolt.shell.workspaceAgentDescription' | 'bolt.agent.working' | 'bolt.agent.failed';

/** A running turn with no agent output for this long is treated as failed so the composer unlocks. */
export const AGENT_TURN_STALE_MS = 60_000;

/** Copy key for the live orb — ready keeps the sheet description, the rest name what is happening. */
export function agentOrbStatusKey(state: AgentOrbState): AgentOrbStatusKey {
	switch (state) {
		case 'ready':
			return 'bolt.shell.workspaceAgentDescription';
		case 'working':
			return 'bolt.agent.working';
		case 'error':
			return 'bolt.agent.failed';
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}

/** In-transcript / composer busy copy. Ready reads as working — the description is header-only. */
export function agentOrbBusyStatusKey(
	state: AgentOrbState
): Exclude<AgentOrbStatusKey, 'bolt.shell.workspaceAgentDescription'> {
	return state === 'error' ? 'bolt.agent.failed' : 'bolt.agent.working';
}

/**
 * Project the durable conversation aggregate into the one product-wide Agent activity state.
 *
 * The session remains the source of truth, so the FAB and an open conversation cannot disagree.
 * A just-submitted request may set `pending` before its turn is replicated; that short interval is
 * deliberately represented as working instead of ready.
 */
export function agentOrbState(input: {
	readonly pending?: boolean;
	readonly failed?: boolean;
	readonly messages?: readonly Readonly<Record<string, unknown>>[];
	readonly turns?: readonly Readonly<Record<string, unknown>>[];
}): AgentOrbState {
	const messages = input.messages ?? [];
	const turns = input.turns ?? [];
	const root = [...turns].filter((turn) => turn.subagent_id == null).at(-1);
	if (input.failed === true || root?.status === 'failed' || root?.status === 'aborted') {
		return 'error';
	}
	const running = input.pending === true || root?.status === 'running' || root?.status === 'queued';
	if (running) return 'working';
	// A tool still marked running with no running turn is a turn that ended mid-call; the orb keeps
	// saying so rather than settling, because the transcript still shows an unfinished step.
	const projected = toPanelMessages(messages, turns);
	const activeTool = projected.some(
		(message) =>
			(message.kind === 'tool' || message.kind === 'agent-message') && message.state === 'running'
	);
	return activeTool ? 'working' : 'ready';
}
