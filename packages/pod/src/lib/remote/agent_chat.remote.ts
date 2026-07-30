import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { runAgent } from '$lib/server/agent/agent-loop.server.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { z } from 'zod';

export const AgentChatInputSchema = z.object({
	message: z.string().min(1),
	/**
	 * Continue an existing conversation. Omitted starts a new one.
	 *
	 * The run id rather than the chat id, because that is what the loop resumes from — and because
	 * `runAgent` already refuses a run belonging to another requestor, so continuation inherits that
	 * check instead of repeating it here.
	 */
	runId: z.uuid().optional()
});

export type AgentChatResult = {
	readonly runId: string;
	readonly chatId: string | null;
	readonly text: string;
};

/**
 * The workspace's own agent tools, all of them.
 *
 * Deliberately not caller-supplied. `executeTool` will only run a tool the spec names, so letting a
 * request choose would let it widen its own reach; an authored tool is a surface the workspace already
 * decided to expose.
 */
function workspaceAgentTools(): readonly string[] {
	return Object.keys(getTenantWorkspace().registered.agentTools);
}

const authenticated = Guard.init().use(requireAuthMiddleware());

/**
 * Talk to the workspace agent.
 *
 * The interactive counterpart to an agent automation, and the same machinery: an interactive
 * conversation is a run with no automation name. It writes the same `chat_session`/`chat_message`
 * transcript, so a conversation replicates to its owner through ordinary sync rather than needing a
 * streaming channel of its own.
 *
 * No collection access is granted. Reaching data goes through an authored agent tool, which is a
 * reviewed surface with its own input schema — an ad-hoc chat should not be a way around that.
 */
export const agentChat = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatResult> => {
		const spec: AgentAutomationSpec = {
			kind: 'agent',
			task: 'Assist with questions about this workspace.',
			tools: workspaceAgentTools() as AgentAutomationSpec['tools']
		};
		const result = await runAgent({
			automationName: null,
			spec,
			input: input.message,
			...(input.runId ? { runId: input.runId } : {})
		});

		const ctx = getWorkspace({ provision: true });
		const session = await ctx.tenantDb.query<{ norbital_id: string }>({
			text: `SELECT norbital_id FROM chat_session WHERE automation_run_id = $1::uuid LIMIT 1`,
			values: [result.runId]
		});
		return {
			runId: result.runId,
			chatId: session.rows[0]?.norbital_id ?? null,
			text: result.text
		};
	}
);
