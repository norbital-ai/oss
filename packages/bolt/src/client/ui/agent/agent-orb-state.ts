import type { ThinkingOrbState } from '@norbital-ai/ui/thinking-orb';
import { toPanelMessages } from '#lib/client/ui/agent/transcript.js';

/**
 * What the orb says, in the three states a reader can actually act on.
 *
 * It used to carry six — idle, thinking, searching, authoring, working, failed — which asked the
 * animation to distinguish "searching" from "authoring" at 20 pixels, and asked the runtime to
 * report which of them was true. Neither held up: the shapes read the same at that size, and the
 * runtime only ever knows whether a turn is running. Three states each mean something different to
 * the person watching: nothing is happening, something is, or something broke. The union now
 * travels with the component in `@norbital-ai/ui/thinking-orb`.
 */

type AgentOrbStatusKey =
	'bolt.shell.workspaceAgentDescription' | 'bolt.agent.working' | 'bolt.agent.failed';

/** Copy key for the live orb — ready keeps the sheet description, the rest name what is happening. */
export function agentOrbStatusKey(state: ThinkingOrbState): AgentOrbStatusKey {
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
	state: ThinkingOrbState
): Exclude<AgentOrbStatusKey, 'bolt.shell.workspaceAgentDescription'> {
	return state === 'error' ? 'bolt.agent.failed' : 'bolt.agent.working';
}

/**
 * The durable conversation aggregate a surface projects the orb from.
 *
 * Only the parts the orb reads — the stored messages and turns, plus the submitted-state flags the
 * panel holds before the store has confirmed anything. Named so the projection reads in the runtime's
 * own vocabulary rather than as an anonymous four-field parameter.
 */
type AgentOrbStateInput = Readonly<{
	readonly pending?: boolean;
	readonly failed?: boolean;
	readonly messages?: readonly Readonly<Record<string, unknown>>[];
	readonly turns?: readonly Readonly<Record<string, unknown>>[];
}>;

/**
 * Project the durable conversation aggregate into the one product-wide Agent activity state.
 *
 * The session remains the source of truth, so the FAB and an open conversation cannot disagree.
 * A just-submitted request may set `pending` before its turn is committed; that short interval is
 * deliberately represented as working instead of ready.
 */
export function agentOrbState(input: AgentOrbStateInput): ThinkingOrbState {
	const messages = input.messages ?? [];
	const turns = input.turns ?? [];
	// Transcript projection marks child-session rows from their spawn result. The active/root session
	// is therefore the first non-delegated conversation represented in the aggregate.
	const rootConversationId = messages.find(
		(message) =>
			message.delegated !== true && typeof message.conversation_id === 'string'
	)?.conversation_id;
	const root = [...turns]
		.toReversed()
		.find(
			(turn) =>
				rootConversationId === undefined || turn.conversation_id === rootConversationId
		);
	if (input.failed === true || root?.status === 'failed') {
		return 'error';
	}
	const running = input.pending === true || root?.status === 'running';
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
