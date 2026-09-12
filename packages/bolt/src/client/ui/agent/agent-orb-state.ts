import type { NorbiusStripState } from '@norbital-ai/ui/norbius-strip';
import type { ConversationStatus } from '@norbital-ai/bolt-protocol';

type AgentOrbStatusKey =
	| 'bolt.shell.workspaceAgentDescription'
	| 'bolt.agent.working'
	| 'bolt.agent.waitingForYou'
	| 'bolt.agent.turnFinished'
	| 'bolt.agent.turnStopped'
	| 'bolt.agent.failed';

export function agentOrbStatusKey(state: NorbiusStripState): AgentOrbStatusKey {
	switch (state) {
		case 'ready':
			return 'bolt.shell.workspaceAgentDescription';
		case 'working':
			return 'bolt.agent.working';
		case 'waiting':
			return 'bolt.agent.waitingForYou';
		case 'done':
			return 'bolt.agent.turnFinished';
		case 'stopped':
			return 'bolt.agent.turnStopped';
		case 'error':
			return 'bolt.agent.failed';
	}
}

export function agentOrbBusyStatusKey(
	state: NorbiusStripState
): Exclude<AgentOrbStatusKey, 'bolt.shell.workspaceAgentDescription'> {
	return state === 'error' ? 'bolt.agent.failed' : 'bolt.agent.working';
}

type AgentOrbStateInput = Readonly<{
	readonly pending?: boolean;
	readonly failed?: boolean;
	readonly status?: ConversationStatus;
}>;

/**
 * Projects the canonical Task lifecycle onto the orb, one member to one member.
 *
 * It used to fold six statuses into three, and two of those folds said something untrue. `attention`
 * — a Task parked on an approval, or on a model choice nobody has made — shared the failure mark, so
 * an agent waiting for a person was indistinguishable from an agent that had broken, in the one
 * state where a person is the only thing that can move it along. `done` and `stopped` shared `ready`,
 * so a turn that finished and a turn somebody halted both read as one that had never run.
 *
 * `pending` and `failed` remain the caller's own overrides: they are what a surface knows about a
 * turn it has just dispatched, before any status has been written for it.
 */
export function agentOrbState(input: AgentOrbStateInput): NorbiusStripState {
	if (input.failed === true || input.status === 'failed') return 'error';
	if (input.status === 'attention') return 'waiting';
	if (input.pending === true || input.status === 'running') return 'working';
	if (input.status === 'done') return 'done';
	if (input.status === 'stopped') return 'stopped';
	return 'ready';
}
