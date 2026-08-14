import { AUTHORING_TOOLS, SEARCH_TOOLS, toPanelMessages } from './transcript.js';

export type AgentOrbState = 'idle' | 'thinking' | 'searching' | 'authoring' | 'working' | 'failed';

export type AgentOrbStatusKey =
	| 'pod.shell.workspaceAgentDescription'
	| 'pod.agent.thinking'
	| 'pod.agent.searching'
	| 'pod.agent.authoring'
	| 'pod.agent.working'
	| 'pod.agent.failed';

/** A running turn with no agent output for this long is treated as failed so the composer unlocks. */
export const AGENT_TURN_STALE_MS = 60_000;

/** Maps a running tool name to the orb lane the shell should show while that tool is active. */
// stupidity:allow Q4 -- exported named helper
export function toolOrbActivity(name: string): 'searching' | 'authoring' | 'working' {
	if (SEARCH_TOOLS.has(name)) return 'searching';
	if (AUTHORING_TOOLS.has(name)) return 'authoring';
	return 'working';
}

/** Copy key for the live orb — idle keeps the sheet description, activity names the current act. */
export function agentOrbStatusKey(state: AgentOrbState): AgentOrbStatusKey {
	switch (state) {
		case 'idle':
			return 'pod.shell.workspaceAgentDescription';
		case 'thinking':
			return 'pod.agent.thinking';
		case 'searching':
			return 'pod.agent.searching';
		case 'authoring':
			return 'pod.agent.authoring';
		case 'working':
			return 'pod.agent.working';
		case 'failed':
			return 'pod.agent.failed';
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}

/** In-transcript / composer busy copy. Idle is treated as thinking — the description is header-only. */
export function agentOrbBusyStatusKey(
	state: AgentOrbState
): Exclude<AgentOrbStatusKey, 'pod.shell.workspaceAgentDescription'> {
	switch (state) {
		case 'idle':
		case 'thinking':
			return 'pod.agent.thinking';
		case 'searching':
			return 'pod.agent.searching';
		case 'authoring':
			return 'pod.agent.authoring';
		case 'working':
			return 'pod.agent.working';
		case 'failed':
			return 'pod.agent.failed';
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}

/**
 * Project the durable conversation aggregate into the one product-wide Agent activity state.
 *
 * The session remains the source of truth, so the FAB and an open conversation cannot disagree.
 * A just-submitted request may set `pending` before its turn is replicated; that short interval is
 * deliberately represented as thinking instead of idle.
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
	if (
		input.failed === true ||
		root?.status === 'failed' ||
		root?.status === 'aborted'
	) {
		return 'failed';
	}
	const running = input.pending === true || root?.status === 'running' || root?.status === 'queued';
	if (!running) return 'idle';

	const projected = toPanelMessages(messages, turns);
	const activeTool = [...projected]
		.reverse()
		.find((message) => message.kind === 'tool' && message.state === 'running');
	if (activeTool?.kind === 'tool') return toolOrbActivity(activeTool.name);

	const last = messages.at(-1);
	if (last?.role === 'assistant' && last.status === 'streaming') return 'authoring';
	return 'thinking';
}
