/**
 * Same-sandbox agent coordination.
 *
 * A sandbox is the acting surface, not "anyone this human can read":
 * - personal web chat → `user:<requestor id>`
 * - a declared channel profile → `channel:<channel key>`
 *
 * User A cannot see User B. A WhatsApp profile cannot see a web user, even when a DM is later
 * attached to that human. Sessions inside one sandbox may list, read, message, and wait on each
 * other. Subagents stay in-session via `spawn_subagent` and are not a second sandbox.
 */
import { z } from 'zod';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { appendChatMessage, readChatSession } from '$lib/server/agent/chat-session.server.js';
import { parseStoredGoalVerdict } from '$lib/shared/agent/goal-verdict.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import type { AiToolSpec } from '@norbital-ai/platform-utils/runtime/binding';

export type DueSandboxWaiter = {
	readonly runId: string;
	readonly waiterSessionId: string;
	readonly targetSessionId: string;
	readonly sandboxKey: string;
	readonly task: string;
	readonly input: Record<string, unknown>;
	readonly wait: Record<string, unknown>;
};

export const SANDBOX_WAIT_RESULT = 'sandbox_wait';

export type AgentSandbox =
	| { readonly kind: 'user'; readonly id: string }
	| { readonly kind: 'channel'; readonly id: string };

export type SessionSandboxRow = {
	readonly norbital_id: string;
	readonly user_id: string;
	readonly channel_key: string | null;
	readonly title: string;
	readonly automation_run_id: string | null;
};

const sessionIdInput = z.object({
	sessionId: z.string().uuid()
});

const messageInput = z.object({
	sessionId: z.string().uuid(),
	message: z.string().trim().min(1).max(4_000)
});

export function sandboxKey(sandbox: AgentSandbox): string {
	switch (sandbox.kind) {
		case 'user':
			return `user:${sandbox.id}`;
		case 'channel':
			return `channel:${sandbox.id}`;
		default: {
			const _exhaustive: never = sandbox;
			throw new Error(`Unhandled agent sandbox: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export function sandboxFromSession(row: {
	readonly user_id: string;
	readonly channel_key: string | null;
}): AgentSandbox {
	if (typeof row.channel_key === 'string' && row.channel_key.length > 0) {
		return { kind: 'channel', id: row.channel_key };
	}
	return { kind: 'user', id: row.user_id };
}

export function sameSandbox(left: AgentSandbox, right: AgentSandbox): boolean {
	return left.kind === right.kind && left.id === right.id;
}

export function sandboxCoordinationTools(): readonly AiToolSpec[] {
	return [
		{
			name: 'list_sandbox_agents',
			description:
				'List other agent sessions in this sandbox only — the same person on web, or the same channel profile. Never another user or another channel.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false }
		},
		{
			name: 'read_sandbox_agent',
			description:
				'Read the status and latest outcome of one same-sandbox session. Refused across users or channel profiles.',
			inputSchema: z.toJSONSchema(sessionIdInput)
		},
		{
			name: 'message_sandbox_agent',
			description:
				'Leave a note on another same-sandbox session. It does not start a turn and cannot reach another user or channel profile.',
			inputSchema: z.toJSONSchema(messageInput)
		},
		{
			name: 'await_sandbox_agent',
			description:
				'Wait until another same-sandbox session finishes its current work, then continue. Refused across users or channel profiles. Waiting parks this turn; the harness resumes when that session settles.',
			inputSchema: z.toJSONSchema(sessionIdInput)
		}
	];
}

export function isSandboxWaitResult(output: Record<string, unknown>): boolean {
	return output.resultType === SANDBOX_WAIT_RESULT && output.waiting === true;
}

export async function executeSandboxAgentTool(input: {
	readonly name: string;
	readonly args: unknown;
	readonly sessionId: string;
	readonly spec: AgentAutomationSpec;
}): Promise<Record<string, unknown> | null> {
	switch (input.name) {
		case 'list_sandbox_agents':
			return listSandboxAgents(input.sessionId);
		case 'read_sandbox_agent':
			return readSandboxAgent(input.sessionId, sessionIdInput.parse(input.args).sessionId);
		case 'message_sandbox_agent': {
			const parsed = messageInput.parse(input.args);
			return messageSandboxAgent(input.sessionId, parsed.sessionId, parsed.message);
		}
		case 'await_sandbox_agent':
			return awaitSandboxAgent(input.sessionId, sessionIdInput.parse(input.args).sessionId, input.spec);
		default:
			return null;
	}
}

export async function listDueSandboxWaiters(
	completedSessionId: string
): Promise<readonly DueSandboxWaiter[]> {
	const ctx = getWorkspace({ provision: true });
	const waiters = await ctx.tenantDb.query<{
		norbital_id: string;
		input: unknown;
	}>({
		text: `SELECT norbital_id, input
		         FROM automation_run
		        WHERE input -> 'sandbox_wait' ->> 'targetSessionId' = $1
		          AND input -> 'sandbox_wait' ->> 'resumedAt' IS NULL
		        LIMIT 20`,
		values: [completedSessionId]
	});
	const due: DueSandboxWaiter[] = [];
	for (const waiter of waiters.rows) {
		const claimed = await claimDueWaiter(waiter.norbital_id, waiter.input, completedSessionId);
		if (claimed) due.push(claimed);
	}
	return due;
}

export async function sandboxWaitResumeMessage(targetSessionId: string): Promise<string> {
	const session = await readChatSession(targetSessionId);
	return [
		'<sandbox-wait>',
		`Session ${targetSessionId} settled.`,
		JSON.stringify(latestOutcome(session.messages)),
		'Continue the original request.',
		'</sandbox-wait>'
	].join('\n');
}

export async function loadSandboxSession(sessionId: string): Promise<SessionSandboxRow> {
	return loadSessionRow(sessionId);
}

export async function markSandboxWaitResumed(waiter: DueSandboxWaiter): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	await updateRecord(
		ctx,
		'automation_run',
		waiter.runId,
		{
			input: {
				...waiter.input,
				sandbox_wait: {
					...waiter.wait,
					resumedAt: new Date().toISOString()
				}
			}
		},
		{ isElevated: true }
	);
}

async function listSandboxAgents(sessionId: string): Promise<Record<string, unknown>> {
	const self = await loadSessionRow(sessionId);
	const sandbox = sandboxFromSession(self);
	const peers = await listPeerRows(sandbox);
	return {
		sandbox: sandboxKey(sandbox),
		sessions: peers.map((peer) => ({
			sessionId: peer.norbital_id,
			title: peer.title,
			self: peer.norbital_id === sessionId
		}))
	};
}

async function readSandboxAgent(
	callerSessionId: string,
	targetSessionId: string
): Promise<Record<string, unknown>> {
	const target = await assertSameSandboxSession(callerSessionId, targetSessionId);
	const session = await readChatSession(target.norbital_id);
	const running = session.turns.some((turn) => turn.status === 'running' && turn.ended_at === null);
	return {
		sessionId: target.norbital_id,
		title: target.title,
		sandbox: sandboxKey(sandboxFromSession(target)),
		running,
		latest: latestOutcome(session.messages)
	};
}

async function messageSandboxAgent(
	callerSessionId: string,
	targetSessionId: string,
	message: string
): Promise<Record<string, unknown>> {
	const target = await assertSameSandboxSession(callerSessionId, targetSessionId);
	if (target.norbital_id === callerSessionId) {
		throw new Error('Message another session in this sandbox, not this one.');
	}
	const session = await readChatSession(target.norbital_id);
	const turnId =
		session.turns.find((turn) => turn.subagent_id === null)?.norbital_id ??
		session.turns[0]?.norbital_id;
	if (!turnId) throw new Error('That session has no turn to attach a note to yet.');
	await appendChatMessage(
		target.norbital_id,
		turnId,
		{ role: 'system', content: `<sandbox-note>\n${message}\n</sandbox-note>` },
		{ kind: 'normal' }
	);
	return { delivered: true, sessionId: target.norbital_id };
}

async function awaitSandboxAgent(
	callerSessionId: string,
	targetSessionId: string,
	spec: AgentAutomationSpec
): Promise<Record<string, unknown>> {
	if (targetSessionId === callerSessionId) {
		throw new Error('Cannot wait for this session. Use spawn_subagent for in-session work.');
	}
	const target = await assertSameSandboxSession(callerSessionId, targetSessionId);
	const session = await readChatSession(target.norbital_id);
	const running = session.turns.some((turn) => turn.status === 'running' && turn.ended_at === null);
	if (!running) {
		return {
			sessionId: target.norbital_id,
			status: 'settled',
			latest: latestOutcome(session.messages)
		};
	}
	const caller = await loadSessionRow(callerSessionId);
	if (!caller.automation_run_id) {
		throw new Error('This session has no run to park while waiting.');
	}
	const ctx = getWorkspace({ provision: true });
	const existing = await ctx.tenantDb.query<{ input: unknown }>({
		text: `SELECT input FROM automation_run WHERE norbital_id = $1::uuid`,
		values: [caller.automation_run_id]
	});
	const input = isRecord(existing.rows[0]?.input) ? existing.rows[0].input : {};
	await updateRecord(
		ctx,
		'automation_run',
		caller.automation_run_id,
		{
			input: {
				...input,
				sandbox_wait: {
					targetSessionId: target.norbital_id,
					waiterSessionId: callerSessionId,
					sandboxKey: sandboxKey(sandboxFromSession(caller)),
					task: spec.task
				}
			}
		},
		{ isElevated: true }
	);
	return {
		resultType: SANDBOX_WAIT_RESULT,
		waiting: true,
		sessionId: target.norbital_id,
		status: 'running'
	};
}

async function claimDueWaiter(
	waiterRunId: string,
	rawInput: unknown,
	completedSessionId: string
): Promise<DueSandboxWaiter | null> {
	const input = isRecord(rawInput) ? rawInput : {};
	const wait = isRecord(input.sandbox_wait) ? input.sandbox_wait : null;
	if (!wait || wait.resumedAt) return null;
	const waiterSessionId = typeof wait.waiterSessionId === 'string' ? wait.waiterSessionId : null;
	const expectedSandbox = typeof wait.sandboxKey === 'string' ? wait.sandboxKey : null;
	const task = typeof wait.task === 'string' ? wait.task : 'Continue the parked work.';
	if (!waiterSessionId || !expectedSandbox) return null;

	const waiter = await loadSessionRow(waiterSessionId);
	const completed = await loadSessionRow(completedSessionId);
	if (sandboxKey(sandboxFromSession(waiter)) !== expectedSandbox) return null;
	if (!sameSandbox(sandboxFromSession(waiter), sandboxFromSession(completed))) return null;
	return {
		runId: waiterRunId,
		waiterSessionId,
		targetSessionId: completedSessionId,
		sandboxKey: expectedSandbox,
		task,
		input,
		wait
	};
}

async function assertSameSandboxSession(
	callerSessionId: string,
	targetSessionId: string
): Promise<SessionSandboxRow> {
	const caller = await loadSessionRow(callerSessionId);
	const target = await loadSessionRow(targetSessionId);
	if (!sameSandbox(sandboxFromSession(caller), sandboxFromSession(target))) {
		throw new Error('Permission denied: that agent is outside this sandbox.');
	}
	return target;
}

async function loadSessionRow(sessionId: string): Promise<SessionSandboxRow> {
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<SessionSandboxRow>({
		text: `SELECT norbital_id, user_id, channel_key, title, automation_run_id
		         FROM chat_session
		        WHERE norbital_id = $1::uuid
		        LIMIT 1`,
		values: [sessionId]
	});
	const row = result.rows[0];
	if (!row) throw new Error('Agent session does not exist');
	return row;
}

async function listPeerRows(sandbox: AgentSandbox): Promise<readonly SessionSandboxRow[]> {
	const ctx = getWorkspace({ provision: true });
	if (sandbox.kind === 'channel') {
		const result = await ctx.tenantDb.query<SessionSandboxRow>({
			text: `SELECT norbital_id, user_id, channel_key, title, automation_run_id
			         FROM chat_session
			        WHERE channel_key = $1
			        ORDER BY norbital_updated_at DESC
			        LIMIT 50`,
			values: [sandbox.id]
		});
		return result.rows;
	}
	const result = await ctx.tenantDb.query<SessionSandboxRow>({
		text: `SELECT norbital_id, user_id, channel_key, title, automation_run_id
		         FROM chat_session
		        WHERE user_id = $1::uuid
		          AND (channel_key IS NULL OR channel_key = '')
		          AND visibility = 'personal'
		        ORDER BY norbital_updated_at DESC
		        LIMIT 50`,
		values: [sandbox.id]
	});
	return result.rows;
}

function latestOutcome(messages: readonly { kind: string; parts?: readonly { content?: unknown }[] }[]): {
	readonly text: string | null;
	readonly goal: { readonly achieved: boolean; readonly summary: string } | null;
} {
	let text: string | null = null;
	let goal: { readonly achieved: boolean; readonly summary: string } | null = null;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const row = messages[index];
		const content = row?.parts?.[0]?.content;
		if (typeof content !== 'string' || !content.trim()) continue;
		if (!goal && row?.kind === 'goal') {
			const verdict = parseStoredGoalVerdict(content);
			if (verdict) goal = { achieved: verdict.achieved, summary: verdict.summary };
			continue;
		}
		if (!text && row?.kind !== 'goal' && row?.kind !== 'usage' && row?.kind !== 'reasoning') {
			text = content.slice(0, 2_000);
		}
		if (text && goal) break;
	}
	return { text, goal };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
