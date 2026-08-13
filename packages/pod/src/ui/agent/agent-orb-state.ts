import { toPanelMessages } from './transcript.js';

export type AgentOrbState = 'idle' | 'thinking' | 'searching' | 'authoring' | 'working';

const SEARCH_TOOLS = new Set(['describe_workspace', 'list_skills', 'read_collection']);
const AUTHORING_TOOLS = new Set(['write_collection']);

/**
 * Project the durable conversation aggregate into the one product-wide Agent activity state.
 *
 * The session remains the source of truth, so the FAB and an open conversation cannot disagree.
 * A just-submitted request may set `pending` before its turn is replicated; that short interval is
 * deliberately represented as thinking instead of idle.
 */
export function agentOrbState(input: {
	readonly pending?: boolean;
	readonly messages?: readonly Readonly<Record<string, unknown>>[];
	readonly turns?: readonly Readonly<Record<string, unknown>>[];
}): AgentOrbState {
	const messages = input.messages ?? [];
	const turns = input.turns ?? [];
	const root = [...turns].filter((turn) => turn.subagent_id == null).at(-1);
	const running = input.pending === true || root?.status === 'running' || root?.status === 'queued';
	if (!running) return 'idle';

	const projected = toPanelMessages(messages, turns);
	const activeTool = [...projected]
		.reverse()
		.find((message) => message.kind === 'tool' && message.state === 'running');
	if (activeTool?.kind === 'tool') {
		if (SEARCH_TOOLS.has(activeTool.name)) return 'searching';
		if (AUTHORING_TOOLS.has(activeTool.name)) return 'authoring';
		return 'working';
	}

	const last = messages.at(-1);
	if (last?.role === 'assistant' && last.status === 'streaming') return 'authoring';
	return 'thinking';
}
