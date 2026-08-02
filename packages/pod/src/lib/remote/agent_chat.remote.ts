import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import { runAgent } from '$lib/server/agent/agent-loop.server.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { error } from '$lib/runtime/http.js';
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

export type AgentChatStartResult = {
	readonly runId: string;
	readonly chatId: string;
	readonly accepted: true;
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

function interactiveSpec(message: string): AgentAutomationSpec {
	const authored = getTenantWorkspace().registered.agent;
	if (authored) return { ...authored, task: message };
	return {
		kind: 'agent',
		task: message,
		tools: workspaceAgentTools() as AgentAutomationSpec['tools']
	};
}

function conversationTitle(message: string): string {
	const compact = message.trim().replace(/\s+/g, ' ');
	return compact.length > 72 ? `${compact.slice(0, 69).trimEnd()}…` : compact || 'Workspace agent';
}

async function prepareConversation(
	message: string,
	runId?: string
): Promise<{ runId: string; chatId: string }> {
	const ctx = getWorkspace({ provision: true });
	const ownerUserId = ctx.baseScope.requestor.norbital_id;
	const createSession = async (
		automationRunId: string
	): Promise<{ runId: string; chatId: string }> => {
		const session = await createRecord(
			ctx,
			'chat_session',
			{
				user_id: ownerUserId,
				automation_run_id: automationRunId,
				title: conversationTitle(message),
				visibility: 'personal'
			},
			{ isElevated: true }
		);
		if (typeof session.norbital_id !== 'string') throw new Error('Agent session has no id');
		return { runId: automationRunId, chatId: session.norbital_id };
	};
	if (runId) {
		const existing = await ctx.tenantDb.query<{
			requested_by_user_id: string;
			automation_name: string | null;
			status: string;
			chat_id: string | null;
		}>({
			text: `SELECT r.requested_by_user_id, r.automation_name, r.status,
			              s.norbital_id AS chat_id
			         FROM automation_run r
			    LEFT JOIN chat_session s ON s.automation_run_id = r.norbital_id
			        WHERE r.norbital_id = $1::uuid
			        LIMIT 1`,
			values: [runId]
		});
		const row = existing.rows[0];
		if (!row || row.automation_name !== null) throw error(404, 'Agent conversation not found');
		if (row.requested_by_user_id !== ownerUserId) throw error(403, 'Agent conversation is private');
		if (row.status === 'running') throw error(409, 'The agent is already responding');
		if (row.chat_id) return { runId, chatId: row.chat_id };
		return createSession(runId);
	}

	const run = await createRecord(
		ctx,
		'automation_run',
		{
			requested_by_user_id: ownerUserId,
			automation_name: null,
			status: 'running',
			input: { task: 'Interactive workspace conversation' },
			started_at: new Date().toISOString()
		},
		{ isElevated: true }
	);
	if (typeof run.norbital_id !== 'string') throw new Error('Agent run has no id');
	return createSession(run.norbital_id);
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
 * The workspace's `src/+agent.ts` profile is the only place interactive collection, workspace-tool
 * and host-tool access can be granted. Without it the compatibility command receives only Pod's
 * read-only built-ins and the workspace's explicitly registered tools; the shell exposes no agent UI.
 */
export const agentChat = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatResult> => {
		const spec = interactiveSpec('Assist with questions about this workspace.');
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

/**
 * Start a live interactive turn and return its transcript identity before provider inference begins.
 *
 * The long-running loop remains inside Pod and writes the tenant transcript. Returning after the
 * run/session exist lets a client subscribe to ordinary sync before the first assistant delta lands.
 */
export const agentChatStart = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatStartResult> => {
		const conversation = await prepareConversation(input.message, input.runId);
		void runAgent({
			automationName: null,
			runId: conversation.runId,
			sessionId: conversation.chatId,
			spec: interactiveSpec(input.message),
			input: input.message
		}).catch(() => undefined);
		return { ...conversation, accepted: true };
	}
);
