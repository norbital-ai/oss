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
import type { GoalVerdict } from '$lib/shared/agent/goal-verdict.js';
import type { ChatSessionMessage } from '$lib/shared/agent/context-window.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import type { AiToolSpec } from '@norbital-ai/platform-utils/runtime/binding';
import {
	automation_run,
	chat_session
} from '@norbital-ai/platform-utils/system/workspace-schema';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

const SandboxWaitSchema = z
	.object({
		targetSessionId: z.string(),
		waiterSessionId: z.string(),
		sandboxKey: z.string(),
		task: z.string().default('Continue the parked work.'),
		resumedAt: z.string().optional()
	})
	.passthrough();
const recordSchema = z.record(z.string(), z.unknown());

const SandboxWaitInputSchema = z
	.object({
		sandbox_wait: SandboxWaitSchema
	})
	.passthrough();

export const DueSandboxWaiterSchema = z.object({
	runId: z.string(),
	waiterSessionId: z.string(),
	targetSessionId: z.string(),
	sandboxKey: z.string(),
	task: z.string(),
	input: z.record(z.string(), z.unknown()),
	wait: SandboxWaitSchema
});
export type DueSandboxWaiter = z.infer<typeof DueSandboxWaiterSchema>;

export const SANDBOX_WAIT_RESULT = 'sandbox_wait';

export const AgentSandboxSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('user'), id: z.string() }),
	z.object({ kind: z.literal('channel'), id: z.string() })
]);
export type AgentSandbox = z.infer<typeof AgentSandboxSchema>;

export type SessionSandboxRow = Pick<
	typeof chat_session.$inferSelect,
	'norbital_id' | 'user_id' | 'channel_key' | 'title' | 'automation_run_id'
>;

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

export function sandboxFromSession(
	row: Pick<SessionSandboxRow, 'user_id' | 'channel_key'>
): AgentSandbox {
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
			return awaitSandboxAgent(
				input.sessionId,
				sessionIdInput.parse(input.args).sessionId,
				input.spec
			);
		default:
			return null;
	}
}

export async function listDueSandboxWaiters(
	completedSessionId: string
): Promise<readonly DueSandboxWaiter[]> {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const waiters = await db
		.select({ norbital_id: automation_run.norbital_id, input: automation_run.input })
		.from(automation_run)
		.where(
			and(
				sql`${automation_run.input} -> 'sandbox_wait' ->> 'targetSessionId' = ${completedSessionId}`,
				sql`${automation_run.input} -> 'sandbox_wait' ->> 'resumedAt' IS NULL`
			)
		)
		.limit(20);
	const due: DueSandboxWaiter[] = [];
	for (const waiter of waiters) {
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
	const self = await loadSandboxSession(sessionId);
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
	const caller = await loadSandboxSession(callerSessionId);
	if (!caller.automation_run_id) {
		throw new Error('This session has no run to park while waiting.');
	}
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const existing = await db
		.select({ input: automation_run.input })
		.from(automation_run)
		.where(eq(automation_run.norbital_id, caller.automation_run_id))
		.limit(1);
	const parsedInput = recordSchema.safeParse(existing[0]?.input);
	const input = parsedInput.success ? parsedInput.data : {};
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
	const parsed = SandboxWaitInputSchema.safeParse(rawInput);
	if (!parsed.success || parsed.data.sandbox_wait.resumedAt) return null;
	const input = parsed.data;
	const wait = input.sandbox_wait;
	const waiterSessionId = wait.waiterSessionId;
	const expectedSandbox = wait.sandboxKey;

	const waiter = await loadSandboxSession(waiterSessionId);
	const completed = await loadSandboxSession(completedSessionId);
	if (sandboxKey(sandboxFromSession(waiter)) !== expectedSandbox) return null;
	if (!sameSandbox(sandboxFromSession(waiter), sandboxFromSession(completed))) return null;
	return {
		runId: waiterRunId,
		waiterSessionId,
		targetSessionId: completedSessionId,
		sandboxKey: expectedSandbox,
		task: wait.task,
		input,
		wait
	};
}

async function assertSameSandboxSession(
	callerSessionId: string,
	targetSessionId: string
): Promise<SessionSandboxRow> {
	const caller = await loadSandboxSession(callerSessionId);
	const target = await loadSandboxSession(targetSessionId);
	if (!sameSandbox(sandboxFromSession(caller), sandboxFromSession(target))) {
		throw new Error('Permission denied: that agent is outside this sandbox.');
	}
	return target;
}

export async function loadSandboxSession(sessionId: string): Promise<SessionSandboxRow> {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const row = (
		await db.select().from(chat_session).where(eq(chat_session.norbital_id, sessionId)).limit(1)
	)[0];
	if (!row) throw new Error('Agent session does not exist');
	return row;
}

async function listPeerRows(sandbox: AgentSandbox): Promise<readonly SessionSandboxRow[]> {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	if (sandbox.kind === 'channel') {
		return db
			.select()
			.from(chat_session)
			.where(eq(chat_session.channel_key, sandbox.id))
			.orderBy(desc(chat_session.norbital_updated_at))
			.limit(50);
	}
	return db
		.select()
		.from(chat_session)
		.where(
			and(
				eq(chat_session.user_id, sandbox.id),
				or(isNull(chat_session.channel_key), eq(chat_session.channel_key, '')),
				eq(chat_session.visibility, 'personal')
			)
		)
		.orderBy(desc(chat_session.norbital_updated_at))
		.limit(50);
}

function latestOutcome(messages: readonly ChatSessionMessage[]) {
	let text: string | null = null;
	let goal: Pick<GoalVerdict, 'achieved' | 'summary'> | null = null;
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
