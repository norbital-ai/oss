import type { ThinkingOrbState } from '@norbital-ai/ui/thinking-orb';
import type { TaskStatus } from '@norbital-ai/bolt-protocol';

type AgentOrbStatusKey =
	| 'bolt.shell.workspaceAgentDescription'
	| 'bolt.agent.working'
	| 'bolt.agent.failed';

export function agentOrbStatusKey(state: ThinkingOrbState): AgentOrbStatusKey {
	switch (state) {
		case 'ready':
			return 'bolt.shell.workspaceAgentDescription';
		case 'working':
			return 'bolt.agent.working';
		case 'error':
			return 'bolt.agent.failed';
	}
}

export function agentOrbBusyStatusKey(
	state: ThinkingOrbState
): Exclude<AgentOrbStatusKey, 'bolt.shell.workspaceAgentDescription'> {
	return state === 'error' ? 'bolt.agent.failed' : 'bolt.agent.working';
}

type AgentOrbStateInput = Readonly<{
	readonly pending?: boolean;
	readonly failed?: boolean;
	readonly status?: TaskStatus;
}>;

/** Projects the canonical Task lifecycle into the product-wide three-state orb. */
export function agentOrbState(input: AgentOrbStateInput): ThinkingOrbState {
	if (input.failed === true || input.status === 'failed' || input.status === 'attention') {
		return 'error';
	}
	if (input.pending === true || input.status === 'running' || input.status === 'waiting') {
		return 'working';
	}
	return 'ready';
}
