import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { PLATFORM_AGENT_READ_TOOL_NAMES } from '$lib/authoring/automations/platform-agent-tools.js';
import type { BeforeApi } from '$lib/authoring/workspace/hook-api.js';
import { createBeforeApi } from '$lib/server/collection/hook-api.server.js';
import {
	createRecord,
	deleteRecord,
	findMany,
	updateRecord
} from '$lib/server/collection/collection_ops.server.js';
import {
	getTenantManifest,
	getTenantWorkspace
} from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getWorkspace, withRequestWorkspaceCtx } from '$lib/server/bootstrap/workspace_store.js';
import { getRuntimeFacilities, requireRuntimeFacility } from '$lib/server/facilities.js';
import { composeSystemPrompt, messagesForProvider } from '$lib/server/agent/system-prompt.js';
import {
	COMPACTION_CONTEXT_RATIO,
	compactionSummarizerPrompt,
	pruneToolResultContent,
	pruneToolResultsInWindow,
	pruneWindowMessage,
	retainTokenBudget,
	shouldAutomaticallyCompact,
	splitRetainedTail
} from '$lib/shared/agent/context-window.js';
import { interactiveAgentSpec } from '$lib/server/agent/agent-spec.server.js';
import {
	appendChatMessage,
	appendChatTurn,
	mutateChatSession,
	openInteractiveAgentTurn,
	readChatSession,
	updateChatTurn
} from '$lib/server/agent/chat-session.server.js';
import {
	composeMentionContext,
	type AgentMentionInput
} from '$lib/server/agent/agent-mentions.server.js';
import { executeMcpTool } from '$lib/server/agent/mcp-tools.server.js';
import {
	allowedCollections,
	assembleToolSpecs,
	collectionReadInput,
	sessionHasBoundSandbox,
	skillReadInput,
	type ResolvedTools
} from '$lib/server/agent/tool-funnel.server.js';
import {
	acceptGoalStop,
	countGoalVerdicts,
	goalContinuationMessage,
	MAX_GOAL_VERIFICATIONS,
	replayGoalVerification,
	readScheduledVerifierPrompt,
	serializeGoalVerdict,
	windowMessageFromStoredGoal
} from '$lib/server/agent/goal-mode.server.js';
import {
	parseStoredVerifierScheduled,
	serializeVerifierScheduled
} from '$lib/shared/agent/goal-verdict.js';
import {
	PLAN_FOLD_INSTRUCTIONS,
	resolveAgentIntent,
	windowContentFromStoredSummary,
	wrapPlanSummary
} from '$lib/shared/agent/intent.js';
import {
	executeSandboxAgentTool,
	isSandboxWaitResult,
	listDueSandboxWaiters,
	loadSandboxSession,
	markSandboxWaitResumed,
	sandboxWaitResumeMessage
} from '$lib/server/agent/sandbox-agents.server.js';
import { listSkillSummaries, readSkillContent } from '$lib/skills/registry.server.js';
import type {
	AiChatResult,
	AiMessage,
	AiToolCall,
	AiToolSpec
} from '@norbital-ai/platform-utils/runtime/binding';
import {
	automationReplayStorage,
	isAutomationEffectYield,
	replayAutomationAi
} from '$lib/server/run/automation-replay.server.js';
import { resolveRequestorBaseScope } from '$lib/server/bootstrap/resolve_workspace.js';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const writeInput = z.discriminatedUnion('action', [
	z.object({ collection: z.string(), action: z.literal('create'), record: recordSchema }),
	z.object({
		collection: z.string(),
		action: z.literal('update'),
		id: z.string().uuid(),
		record: recordSchema
	}),
	z.object({ collection: z.string(), action: z.literal('delete'), id: z.string().uuid() })
]);

/**
 * A directive typed into the composer rather than a message for the model.
 *
 * Matched on the whole message, not a prefix: `/compacting the schema` is a sentence, and treating
 * anything merely starting with the word as a command would swallow it. Bare `/compact` is what Core
 * matched; the trailing instructions are new, and must be separated by whitespace to count.
 */
const COMPACT_DIRECTIVE = /^\/compact(?:\s+([\s\S]+))?$/;

/** Parse a whole-message `/compact` directive, optionally with trailing instructions. */
export function parseCompactDirective(message: string): { readonly instructions?: string } | null {
	const match = COMPACT_DIRECTIVE.exec(message.trim());
	if (!match) return null;
	const instructions = match[1]?.trim();
	return instructions ? { instructions } : {};
}

export {
	COMPACTION_CONTEXT_RATIO,
	shouldAutomaticallyCompact
} from '$lib/shared/agent/context-window.js';

/** Context length of the selected host model, when the catalog reports one. */
async function selectedModelContextLength(spec: AgentAutomationSpec): Promise<number | null> {
	const models = getRuntimeFacilities().ai?.models;
	if (!models) return null;
	try {
		const catalog = await models();
		const selected = spec.model ?? catalog.defaultModel;
		return catalog.options.find((option) => option.id === selected)?.contextLength ?? null;
	} catch {
		// A catalog outage must not invent a denominator. Manual `/compact` remains available.
		return null;
	}
}

/** Below this there is nothing a summary would usefully replace. */
const COMPACTION_FLOOR_MESSAGES = 4;

type TranscriptWriter = {
	readonly sessionId: string;
	persist(
		message: AiMessage,
		turnId: string,
		extra?: Record<string, unknown>
	): Promise<string | null>;
};

/** Narrow unknown usage payloads to a record, or an empty object. */
function objectValue(value: unknown): Record<string, unknown> {
	return recordSchema.safeParse(value).success ? (value as Record<string, unknown>) : { value };
}

/** Token count from a provider usage payload, or zero when unreported. */
function usageTokens(usage: unknown): number {
	if (!recordSchema.safeParse(usage).success) return 0;
	const record = usage as Record<string, unknown>;
	for (const key of ['totalTokens', 'total_tokens', 'total']) {
		if (typeof record[key] === 'number') return record[key];
	}
	const input =
		typeof record.inputTokens === 'number'
			? record.inputTokens
			: typeof record.input_tokens === 'number'
				? record.input_tokens
				: 0;
	const output =
		typeof record.outputTokens === 'number'
			? record.outputTokens
			: typeof record.output_tokens === 'number'
				? record.output_tokens
				: 0;
	return input + output;
}

/** Assemble the tool specs this turn may name, including host and workspace tools. */
async function resolveTools(
	spec: AgentAutomationSpec,
	options: { readonly canSpawnSubagent: boolean; readonly planMode: boolean }
): Promise<ResolvedTools> {
	return assembleToolSpecs({
		surface: 'agent',
		spec,
		planMode: options.planMode,
		canSpawnSubagent: options.canSpawnSubagent,
		sandboxBound: sessionHasBoundSandbox('agent')
	});
}

const MUTATION_METHODS = new Set(['create', 'update', 'delete']);

/** Scoped workspace API a tenant-authored tool runs through. */
function agentToolApi(spec: AgentAutomationSpec): BeforeApi {
	const api = createBeforeApi();
	const collections = allowedCollections(spec);
	const assertCollection = (property: PropertyKey): void => {
		if (typeof property === 'string' && !collections.has(property)) {
			throw new Error(`Agent cannot access collection ${property}`);
		}
	};
	const query = new Proxy(Reflect.get(api.db, 'query') as object, {
		get(target, property, receiver) {
			assertCollection(property);
			return Reflect.get(target, property, receiver);
		}
	});
	const db = new Proxy(api.db as object, {
		get(target, property, receiver) {
			if (property === 'query') return query;
			assertCollection(property);
			const collectionApi = Reflect.get(target, property, receiver);
			if (collectionApi == null || typeof collectionApi !== 'object') return collectionApi;
			if ((spec.access ?? 'read') === 'write') return collectionApi;
			return new Proxy(collectionApi, {
				get(collectionTarget, method, methodReceiver) {
					if (typeof method === 'string' && MUTATION_METHODS.has(method)) {
						throw new Error('Agent has read-only data access');
					}
					return Reflect.get(collectionTarget, method, methodReceiver);
				}
			});
		}
	});
	return { ...api, db } as unknown as BeforeApi;
}

const PLAN_MODE_READ_TOOLS = new Set<string>(PLATFORM_AGENT_READ_TOOL_NAMES);

/** Dispatch one tool call through the workspace, host, MCP, or sandbox funnel. */
async function executeTool(
	spec: AgentAutomationSpec,
	resolved: ResolvedTools,
	call: AiToolCall,
	planMode: boolean,
	sessionId: string
): Promise<Record<string, unknown>> {
	if (planMode && !PLAN_MODE_READ_TOOLS.has(call.name)) {
		throw new Error('Permission denied: this turn is in plan mode.');
	}
	const sandbox = await executeSandboxAgentTool({
		name: call.name,
		args: call.input,
		sessionId,
		spec
	});
	if (sandbox) return sandbox;
	const ctx = getWorkspace({ provision: true });
	const collections = allowedCollections(spec);
	if (call.name === 'describe_workspace') {
		return {
			manifest: getTenantManifest(),
			relevantCollections: [...collections]
		};
	}
	if (call.name === 'list_skills') {
		return { skills: await listSkillSummaries() };
	}
	if (call.name === 'read_skill') {
		const input = skillReadInput.parse(call.input);
		return { ...(await readSkillContent(input.name, input.file)) };
	}
	if (call.name === 'read_collection') {
		const input = collectionReadInput.parse(call.input);
		if (!collections.has(input.collection)) {
			throw new Error(`Agent cannot read collection ${input.collection}`);
		}
		const rows = await findMany(ctx, input.collection, {
			...(input.where ? { where: input.where } : {}),
			limit: input.limit ?? 100
		} as never);
		return { rows };
	}
	if (call.name === 'write_collection') {
		if ((spec.access ?? 'read') !== 'write') throw new Error('Agent has read-only data access');
		const input = writeInput.parse(call.input);
		if (!collections.has(input.collection)) {
			throw new Error(`Agent cannot write collection ${input.collection}`);
		}
		if (input.action === 'create') {
			return { record: await createRecord(ctx, input.collection, input.record) };
		}
		if (input.action === 'update') {
			return { record: await updateRecord(ctx, input.collection, input.id, input.record) };
		}
		await deleteRecord(ctx, input.collection, input.id);
		return { deletedId: input.id };
	}
	// Host tools before workspace tools, and gated on the set this run resolved rather than on the raw
	// spec: a name only reaches here if `resolveTools` both found it on the host and proved it shadows
	// nothing, so the two branches can never both claim one call.
	if (resolved.hostTools.has(call.name)) {
		const binding = requireRuntimeFacility('agentTools');
		return objectValue(
			await binding.run(call.name, call.input, {
				sandboxPrincipalId: ctx.baseScope.requestor.norbital_id,
				...(spec.hostSandbox?.workspace ? { sandboxWorkspace: spec.hostSandbox.workspace } : {})
			})
		);
	}
	if (resolved.mcpTools.has(call.name)) {
		return executeMcpTool(spec, call.name, call.input);
	}
	const definition = getTenantWorkspace().registered.agentTools[call.name];
	if (!definition || !resolved.workspaceTools.has(call.name)) {
		throw new Error(`Agent cannot execute tenant tool ${call.name}`);
	}
	return objectValue(await definition.run(agentToolApi(spec), definition.input.parse(call.input)));
}

/**
 * The session holding one automation run's transcript, created on first write.
 *
 * An automation's agent run and a person talking to the agent produce the same messages, so they
 * share one transcript model rather than two tables that drift. The session is keyed by its run.
 */
async function ensureRunSession(runId: string, ownerUserId: string): Promise<string> {
	const ctx = getWorkspace({ provision: true });
	const existing = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `SELECT norbital_id FROM chat_session WHERE automation_run_id = $1::uuid LIMIT 1`,
		values: [runId]
	});
	const found = existing.rows[0]?.norbital_id;
	if (found) return found;
	const created = await createRecord(
		ctx,
		'chat_session',
		{
			user_id: ownerUserId,
			automation_run_id: runId,
			title: `Automation run ${runId}`,
			visibility: 'personal'
		},
		{ isElevated: true }
	);
	return String(created.norbital_id);
}

/** Map a stored goal row back into the model window, or drop a scheduled-verifier marker. */
function windowMessageFromGoalRow(content: string): AiMessage | null {
	if (parseStoredVerifierScheduled(content)) return null;
	return windowMessageFromStoredGoal(content);
}

/** Rebuild one window message from a stored transcript row. */
function windowMessageFromStoredRow(
	kind: string | undefined,
	message: AiMessage
): AiMessage | null {
	if (kind === 'summary') {
		return {
			role: 'user',
			content: windowContentFromStoredSummary(
				typeof message.content === 'string' ? message.content : ''
			)
		};
	}
	if (kind === 'goal') {
		return windowMessageFromGoalRow(typeof message.content === 'string' ? message.content : '');
	}
	return pruneWindowMessage(message);
}

export type AgentRunResult = {
	readonly runId: string;
	readonly status: 'success';
	readonly text: string;
	/** The transcript this run appended to — the caller's own session, or the one keyed to the run. */
	readonly sessionId: string | null;
	/** The stored id of the input message, so a caller can point its own row at the transcript. */
	readonly inputMessageId: string | null;
};

/** Persist helper bound to one chat session. */
function createTranscriptWriter(sessionId: string): TranscriptWriter {
	return {
		sessionId,
		async persist(message, turnId, extra): Promise<string | null> {
			return appendChatMessage(sessionId, turnId, message, extra);
		}
	};
}

/** Open a turn on the session, including a child turn when spawning. */
async function createTurn(input: {
	readonly writer: TranscriptWriter;
	readonly spec: AgentAutomationSpec;
	readonly parentTurnId?: string;
	readonly subagentId?: string;
}): Promise<string> {
	return appendChatTurn(input.writer.sessionId, {
		model: input.spec.model ?? 'host-default',
		...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
		...(input.subagentId ? { subagentId: input.subagentId } : {})
	});
}

/** What the provider said one message cost. `null` cost means unreported, never free. */
function messageSpend(usage: unknown): { tokens: number; cost: number | null } {
	if (!recordSchema.safeParse(usage).success) return { tokens: 0, cost: null };
	const record = usage as Record<string, unknown>;
	for (const key of ['cost', 'total_cost', 'totalCost']) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return { tokens: usageTokens(usage), cost: value };
		}
	}
	return { tokens: usageTokens(usage), cost: null };
}

/**
 * Add one finished turn to its conversation's running totals, at most once.
 *
 * Read from the turn's own messages while they are still there, then stored on the session as a
 * counter. Deleting a message afterwards removes the record of a request but not the fact that it
 * was paid for, so the total has to be accumulated rather than derived — a sum over surviving rows
 * would quietly fall every time someone tidied a transcript.
 *
 * One locked aggregate transaction, so terminal state and its counters cannot come apart.
 * `usage_settled_at` is the idempotency gate: a retry after an ordinary error or an uncertain commit
 * returns without adding anything. Compaction is invisible to this by construction — a checkpoint
 * changes which messages the model is sent, not which ones were paid for, and the summariser's own
 * usage is persisted onto the checkpoint row so it is counted like any other call.
 */
async function finishTurn(
	sessionId: string,
	turnId: string,
	status: 'succeeded' | 'failed' | 'aborted',
	error?: string
): Promise<void> {
	let lastCause: unknown;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			await mutateChatSession(sessionId, (session) => {
				const turnIndex = session.turns.findIndex((turn) => turn.norbital_id === turnId);
				const turn = session.turns[turnIndex];
				if (!turn) throw new Error('Chat turn does not exist');
				// A retry after an uncertain commit must not change the original terminal result or add
				// its spend twice. Terminal state and settlement are written by this one transaction.
				if (turn.usage_settled_at !== null && turn.ended_at !== null) return;
				let tokens = 0;
				let cost = 0;
				let reported = false;
				let unreported = false;
				for (const message of session.messages) {
					if (message.turn_id !== turnId || message.usage === null) continue;
					const spend = messageSpend(message.usage);
					tokens += spend.tokens;
					if (spend.cost === null) unreported = true;
					else {
						cost += spend.cost;
						reported = true;
					}
				}
				if (!reported) unreported = true;
				const settledAt = new Date().toISOString();
				session.turns[turnIndex] = {
					...turn,
					status,
					heartbeat_at: settledAt,
					ended_at: settledAt,
					error: error ?? null,
					usage_settled_at: settledAt
				};
				session.usage_cost_usd += cost;
				session.usage_total_tokens += tokens;
				session.usage_turns_counted += 1;
				session.usage_turns_unreported += unreported ? 1 : 0;
			});
			return;
		} catch (cause) {
			lastCause = cause;
		}
	}
	throw new Error('Agent turn settlement failed after 3 attempts', { cause: lastCause });
}

/** Surface both the run failure and a later settlement failure. */
function combinedTurnFailure(cause: unknown, settlementCause: unknown): AggregateError {
	return new AggregateError(
		[cause, settlementCause],
		`Agent run failed and its usage could not be settled: ${
			settlementCause instanceof Error ? settlementCause.message : String(settlementCause)
		}`
	);
}

/** Tool calls the loop may execute; a max-tokens stop yields none. */
function executableToolCalls(
	stopReason: AiChatResult['stopReason'],
	toolCalls: readonly AiToolCall[] | undefined
): readonly AiToolCall[] {
	if (stopReason === 'max_tokens') return [];
	return toolCalls ?? [];
}

/** Pruned tool result for the next provider window. */
function windowToolMessage(output: Record<string, unknown>, callId: string): AiMessage {
	const content = JSON.stringify(output);
	return {
		role: 'tool',
		content: pruneToolResultContent(content),
		toolCallId: callId
	};
}

/** Full tool result stored on the transcript. */
function persistableToolMessage(output: Record<string, unknown>, callId: string): AiMessage {
	return {
		role: 'tool',
		content: JSON.stringify(output),
		toolCallId: callId
	};
}

/** Split a window into the prefix to summarize and the tail to keep verbatim. */
function compactionSpans(
	messages: AiMessage[],
	fold: 'plan' | undefined,
	contextLength: number | null | undefined
): { readonly head: AiMessage[]; readonly tail: AiMessage[] } {
	const pruned = pruneToolResultsInWindow(messages);
	if (fold === 'plan') return { head: pruned, tail: [] };
	const { head, tail } = splitRetainedTail(
		pruned,
		retainTokenBudget({ contextLength: contextLength ?? null, messages: pruned })
	);
	return head.length > 0 ? { head, tail } : { head: pruned, tail: [] };
}

type LoopResult = { readonly text: string; readonly consumedTokens: number };

/** Ordinal of the effect this durable step just consumed. */
function lastConsumedOrdinal(): number {
	const replay = automationReplayStorage.getStore();
	if (!replay) throw new Error('Durable agent turns require an automation receipt replay context');
	return replay.nextOrdinal - 1;
}

/**
 * Turn-stopping end-action for every root intent, including plan: an independent verifier
 * decides whether the main agent may stop.
 *
 * Returns true when the loop should continue. Subagents never enter this gate. After a stop,
 * the caller folds a settled plan window — this function does not.
 */
async function continueAfterGoalVerification(input: {
	readonly goalMode: boolean;
	readonly depth: number;
	readonly userRequest: string;
	readonly messages: AiMessage[];
	readonly spec: AgentAutomationSpec;
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly verifierPrompt: string;
}): Promise<boolean> {
	if (!input.goalMode || input.depth !== 0) return false;
	const ordinal = lastConsumedOrdinal();
	const attempts = await countGoalVerdicts(input.writer.sessionId, input.turnId, {
		beforeOrdinal: ordinal + 1
	});
	if (attempts >= MAX_GOAL_VERIFICATIONS) return false;
	const scheduled = await readScheduledVerifierPrompt(input.writer.sessionId, input.turnId);
	const verdict = replayGoalVerification({
		spec: input.spec,
		userRequest: input.userRequest,
		messages: input.messages,
		verifierPrompt: scheduled ?? input.verifierPrompt
	});
	if (!(await turnHasDurableOrdinal(input.writer.sessionId, input.turnId, ordinal))) {
		await input.writer.persist(
			{ role: 'system', content: serializeGoalVerdict(verdict) },
			input.turnId,
			{ kind: 'goal', durable_ordinal: ordinal }
		);
	}
	if (acceptGoalStop(verdict, attempts + 1)) return false;
	input.messages.push(goalContinuationMessage(verdict));
	return true;
}

/** Admit a follow-up turn for each session waiting on this completed sandbox run. */
async function resumeSandboxWaiters(completedSessionId: string): Promise<void> {
	const waiters = await listDueSandboxWaiters(completedSessionId);
	if (waiters.length === 0) return;
	// Circular: automation-dispatch owns admission and already imports this loop.
	const { admitAgentTurn, channelAgentAutomationName, INTERACTIVE_AGENT_AUTOMATION_NAME } =
		await import('$lib/server/run/automation-dispatch.server.js');
	for (const waiter of waiters) {
		try {
			const spec = await interactiveAgentSpec(waiter.task);
			const opened = await prepareInteractiveAgentTurn({
				sessionId: waiter.waiterSessionId,
				spec,
				message: await sandboxWaitResumeMessage(waiter.targetSessionId)
			});
			const row = await loadSandboxSession(waiter.waiterSessionId);
			await admitAgentTurn(getWorkspace({ provision: true }), {
				automationName: row.channel_key
					? channelAgentAutomationName(row.channel_key)
					: INTERACTIVE_AGENT_AUTOMATION_NAME,
				triggerKey: `turn:${waiter.waiterSessionId}:${opened.turnId}`,
				originScope: getWorkspace({ provision: true }).baseScope,
				snapshot: {
					sessionId: waiter.waiterSessionId,
					runId: waiter.runId,
					turnId: opened.turnId,
					promptContent: opened.promptContent,
					spec,
					input: opened.promptContent,
					...(opened.inputMessageId ? { inputMessageId: opened.inputMessageId } : {})
				}
			});
			await markSandboxWaitResumed(waiter);
		} catch (error) {
			console.error('[sandbox-wait]', { runId: waiter.runId, error });
		}
	}
}

/** Requestor id stamped on the automation scope, when present. */
function requestorIdFromScope(scope: Record<string, unknown> | undefined): string | null {
	const requestor = scope?.requestor;
	if (!requestor || typeof requestor !== 'object' || Array.isArray(requestor)) return null;
	const id = (requestor as { norbital_id?: unknown }).norbital_id;
	return typeof id === 'string' ? id : null;
}

/** Run as the originating requestor when the receipt scope names a different user. */
async function withOriginRequestor<T>(
	scope: Record<string, unknown> | undefined,
	run: () => Promise<T>
): Promise<T> {
	const requestorId = requestorIdFromScope(scope);
	if (!requestorId) return run();
	const ctx = getWorkspace({ provision: true });
	if (ctx.baseScope.requestor.norbital_id === requestorId) return run();
	const resolved = await resolveRequestorBaseScope({
		tenantDb: ctx.tenantDb,
		organization: ctx.organization,
		userId: requestorId
	});
	if (!resolved) return run();
	return withRequestWorkspaceCtx(
		{ ...ctx, baseScope: resolved.baseScope, userOrganizations: [] },
		run
	);
}

export type DurableAgentChannelDelivery = {
	readonly channelKey: string;
	readonly transport: string;
	readonly conversationId: string;
	readonly inboundReceiptId: string;
	readonly conversationRowId: string;
};

export type DurableAgentTurnSnapshot = {
	readonly sessionId: string;
	readonly runId: string;
	readonly turnId: string;
	readonly promptContent: string;
	readonly spec: AgentAutomationSpec;
	readonly input?: string;
	readonly inputMessageId?: string | null;
	readonly planMode?: boolean;
	readonly goalMode?: boolean;
	readonly intent?: 'do' | 'plan';
	readonly verifierPrompt?: string;
	readonly compact?: { readonly instructions?: string };
	readonly mentions?: readonly AgentMentionInput[];
	readonly inputMetadata?: Record<string, unknown>;
	readonly channel?: DurableAgentChannelDelivery;
};

/** Narrow unknown JSON to a record, or an empty object. */
function asRecord(value: unknown): Record<string, unknown> {
	return recordSchema.safeParse(value).success ? (value as Record<string, unknown>) : {};
}

/** Parse a durable turn snapshot from an incoming automation record. */
function snapshotFromRecord(value: unknown): DurableAgentTurnSnapshot | null {
	const record = asRecord(value);
	if (
		typeof record.sessionId !== 'string' ||
		typeof record.runId !== 'string' ||
		typeof record.turnId !== 'string' ||
		typeof record.promptContent !== 'string'
	) {
		return null;
	}
	const specValue = record.spec;
	if (!specValue || typeof specValue !== 'object' || Array.isArray(specValue)) return null;
	const spec = specValue as AgentAutomationSpec;
	if (
		spec.kind !== 'agent' ||
		typeof spec.task !== 'string' ||
		typeof spec.description !== 'string'
	) {
		return null;
	}
	return {
		sessionId: record.sessionId,
		runId: record.runId,
		turnId: record.turnId,
		promptContent: record.promptContent,
		spec,
		...(typeof record.input === 'string' ? { input: record.input } : {}),
		...(typeof record.inputMessageId === 'string' ? { inputMessageId: record.inputMessageId } : {}),
		...(record.planMode === true ? { planMode: true } : {}),
		...(record.goalMode === true ? { goalMode: true } : {}),
		...(record.intent === 'do' || record.intent === 'plan' ? { intent: record.intent } : {}),
		...(typeof record.verifierPrompt === 'string' && record.verifierPrompt
			? { verifierPrompt: record.verifierPrompt }
			: {}),
		...(record.compact && typeof record.compact === 'object' && !Array.isArray(record.compact)
			? {
					compact: {
						...((record.compact as { instructions?: unknown }).instructions
							? {
									instructions: String((record.compact as { instructions?: unknown }).instructions)
								}
							: {})
					}
				}
			: {}),
		...(Array.isArray(record.mentions) ? { mentions: record.mentions as AgentMentionInput[] } : {}),
		...(record.inputMetadata &&
		typeof record.inputMetadata === 'object' &&
		!Array.isArray(record.inputMetadata)
			? { inputMetadata: record.inputMetadata as Record<string, unknown> }
			: {}),
		...(record.channel && typeof record.channel === 'object' && !Array.isArray(record.channel)
			? { channel: record.channel as DurableAgentChannelDelivery }
			: {})
	};
}

/** Rebuild the provider window for this turn from the stored transcript. */
async function loadDurableTurnWindow(
	sessionId: string,
	turnId: string,
	promptContent: string
): Promise<AiMessage[]> {
	const session = await readChatSession(sessionId);
	const subagentTurns = new Set(
		session.turns.filter((turn) => turn.subagent_id !== null).map((turn) => turn.norbital_id)
	);
	const prior = session.messages.filter(
		(message) =>
			message.kind !== 'usage' &&
			message.kind !== 'reasoning' &&
			(message.turn_id === null || !subagentTurns.has(message.turn_id)) &&
			message.turn_id !== turnId
	);
	const anchor = prior.findLastIndex((message) => message.kind === 'summary');
	const replay = anchor < 0 ? prior : prior.slice(anchor);
	const messages: AiMessage[] = [];
	for (const row of replay) {
		const message = row.parts?.[0];
		if (!message) continue;
		const next = windowMessageFromStoredRow(row.kind, message);
		if (next) messages.push(next);
	}
	messages.push({ role: 'user', content: promptContent });
	return messages;
}

/** Stored tool result for this call, when a prior attempt already persisted it. */
function toolResultFromSession(
	sessionId: string,
	turnId: string,
	callId: string
): Promise<AiMessage | null> {
	return readChatSession(sessionId).then((session) => {
		const row = session.messages.find(
			(message) =>
				message.turn_id === turnId &&
				message.role === 'tool' &&
				message.parts[0]?.role === 'tool' &&
				message.parts[0].toolCallId === callId
		);
		return row?.parts[0] ?? null;
	});
}

/** Whether this turn already recorded a message for the given durable ordinal. */
async function turnHasDurableOrdinal(
	sessionId: string,
	turnId: string,
	ordinal: number
): Promise<boolean> {
	const session = await readChatSession(sessionId);
	return session.messages.some(
		(message) => message.turn_id === turnId && message.durable_ordinal === ordinal
	);
}

/** Replace the window prefix with a fenced summarizer checkpoint. */
async function compactDurableWindow(input: {
	readonly messages: AiMessage[];
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly spec: AgentAutomationSpec;
	readonly instructions?: string;
	readonly fold?: 'plan';
	readonly contextLength?: number | null;
}): Promise<void> {
	const { head, tail } = compactionSpans(input.messages, input.fold, input.contextLength);
	const summary = replayAutomationAi({
		request: {
			kind: 'ai.prompt',
			prompt: compactionSummarizerPrompt(head, input.instructions),
			...(input.spec.model ? { model: input.spec.model } : {}),
			...(input.spec.profile ? { profile: input.spec.profile } : {})
		}
	});
	if (typeof summary !== 'string' || !summary.trim()) {
		throw new Error('The summarizer returned nothing to checkpoint');
	}
	const stored = input.fold === 'plan' ? wrapPlanSummary(summary.trim()) : summary.trim();
	const ordinal = lastConsumedOrdinal();
	if (!(await turnHasDurableOrdinal(input.writer.sessionId, input.turnId, ordinal))) {
		await input.writer.persist({ role: 'system', content: stored }, input.turnId, {
			kind: 'summary',
			durable_ordinal: ordinal
		});
	}
	input.messages.splice(
		0,
		input.messages.length,
		{ role: 'user', content: windowContentFromStoredSummary(stored) },
		...tail
	);
}

/**
 * Fold a settled plan turn into a `kind: 'summary'` checkpoint the next window will start from.
 *
 * A failed fold must not fail a finished turn. Durable replay still rethrows when the receipt is
 * pending, so the fold can run again on the next attempt.
 */
async function foldSettledPlanWindow(input: {
	readonly foldAsCheckpoint: boolean;
	readonly messages: AiMessage[];
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly spec: AgentAutomationSpec;
}): Promise<void> {
	if (!input.foldAsCheckpoint || input.messages.length === 0) return;
	try {
		await compactDurableWindow({
			messages: input.messages,
			writer: input.writer,
			turnId: input.turnId,
			spec: input.spec,
			instructions: PLAN_FOLD_INSTRUCTIONS,
			fold: 'plan'
		});
	} catch (cause) {
		if (automationReplayStorage.getStore()?.pending) throw cause;
	}
}

/**
 * Replay one fenced provider turn from the host's settled `ai.turn` effect.
 */
function replayProviderTurn(input: {
	readonly messages: readonly AiMessage[];
	readonly tools: readonly AiToolSpec[];
	readonly spec: AgentAutomationSpec;
	readonly planMode: boolean;
	readonly goalMode: boolean;
}): AiChatResult {
	const system = composeSystemPrompt(input.spec.systemPrompt);
	const result = replayAutomationAi({
		request: {
			kind: 'ai.turn',
			messages: messagesForProvider(input.messages, {
				planMode: input.planMode,
				goalMode: input.goalMode
			}),
			system,
			tools: [...input.tools],
			...(input.spec.model ? { model: input.spec.model } : {}),
			...(input.spec.profile ? { profile: input.spec.profile } : {})
		}
	});
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new Error('Durable agent turn expected a provider result');
	}
	const parsed = result as AiChatResult;
	if (typeof parsed.text !== 'string' || typeof parsed.stopReason !== 'string') {
		throw new Error('Durable agent turn returned an invalid provider result');
	}
	return parsed;
}

/** Persist a settled provider result and execute any tool calls it named. */
async function applySettledProviderTurn(input: {
	readonly spec: AgentAutomationSpec;
	readonly resolved: ResolvedTools;
	readonly messages: AiMessage[];
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly depth: number;
	readonly planMode: boolean;
	readonly result: AiChatResult;
	consumedTokens: number;
}): Promise<{
	readonly done: boolean;
	readonly waiting?: boolean;
	readonly text: string;
	readonly consumedTokens: number;
}> {
	const ordinal = lastConsumedOrdinal();
	const already = await turnHasDurableOrdinal(input.writer.sessionId, input.turnId, ordinal);
	if (!already) {
		if (input.result.reasoning) {
			await input.writer.persist(
				{ role: 'assistant', content: input.result.reasoning },
				input.turnId,
				{ kind: 'reasoning', model: input.spec.model ?? null, durable_ordinal: ordinal }
			);
		}
		if (input.result.text) {
			await input.writer.persist({ role: 'assistant', content: input.result.text }, input.turnId, {
				status: 'complete',
				model: input.spec.model ?? null,
				durable_ordinal: ordinal
			});
		}
		if (input.result.usage !== undefined) {
			await input.writer.persist({ role: 'assistant', content: '' }, input.turnId, {
				kind: 'usage',
				status: 'complete',
				model: input.spec.model ?? null,
				usage: objectValue(input.result.usage),
				durable_ordinal: ordinal
			});
		}
		const calls = executableToolCalls(input.result.stopReason, input.result.toolCalls);
		if (calls.length > 0) {
			await input.writer.persist(
				{ role: 'assistant', content: '', toolCalls: calls },
				input.turnId,
				{ durable_ordinal: ordinal }
			);
		} else if (!input.result.reasoning && !input.result.text && input.result.usage === undefined) {
			await input.writer.persist({ role: 'assistant', content: '' }, input.turnId, {
				kind: 'usage',
				status: 'complete',
				model: input.spec.model ?? null,
				durable_ordinal: ordinal
			});
		}
	}

	let finalText = '';
	if (input.result.text) {
		finalText = input.result.text;
		input.messages.push({ role: 'assistant', content: input.result.text });
	}
	const calls = executableToolCalls(input.result.stopReason, input.result.toolCalls);
	if (calls.length > 0) {
		input.messages.push({ role: 'assistant', content: '', toolCalls: calls });
	}
	input.consumedTokens += usageTokens(input.result.usage);
	if (input.spec.maxTokens && input.consumedTokens > input.spec.maxTokens) {
		throw new Error(
			`Agent token budget exceeded (${input.consumedTokens} of ${input.spec.maxTokens} tokens)`
		);
	}
	if (calls.length === 0) {
		if (input.result.stopReason === 'refusal') throw new Error('AI provider refused the run');
		return { done: true, text: finalText, consumedTokens: input.consumedTokens };
	}

	for (const call of calls) {
		const existing = await toolResultFromSession(input.writer.sessionId, input.turnId, call.id);
		let output: Record<string, unknown> | undefined;
		try {
			if (call.name === 'spawn_subagent') {
				if (input.planMode) throw new Error('Permission denied: this turn is in plan mode.');
				if (input.depth !== 0) throw new Error('Subagents cannot spawn another subagent');
				const task = z.object({ task: z.string().min(1) }).parse(call.input).task;
				const child = await runDurableSubagent({
					spec: input.spec,
					task,
					writer: input.writer,
					parentTurnId: input.turnId,
					subagentId: `subagent:${call.id}`,
					depth: input.depth + 1,
					planMode: input.planMode
				});
				output = { text: child.text, turnId: child.turnId };
			} else if (existing) {
				input.messages.push(pruneWindowMessage(existing));
				continue;
			} else {
				output = await executeTool(
					input.spec,
					input.resolved,
					call,
					input.planMode,
					input.writer.sessionId
				);
				if (isSandboxWaitResult(output)) {
					input.messages.push(windowToolMessage(output, call.id));
					await input.writer.persist(persistableToolMessage(output, call.id), input.turnId, {
						durable_ordinal: ordinal
					});
					return {
						done: true,
						waiting: true,
						text: finalText,
						consumedTokens: input.consumedTokens
					};
				}
			}
		} catch (cause) {
			if (isAutomationEffectYield(cause) || automationReplayStorage.getStore()?.pending) {
				throw cause;
			}
			output = { error: cause instanceof Error ? cause.message : String(cause) };
		}
		if (existing) {
			input.messages.push(pruneWindowMessage(existing));
			continue;
		}
		if (!output) throw new Error(`Agent tool ${call.name} produced no result`);
		input.messages.push(windowToolMessage(output, call.id));
		await input.writer.persist(persistableToolMessage(output, call.id), input.turnId, {
			durable_ordinal: ordinal
		});
		await updateChatTurn(input.writer.sessionId, input.turnId, {
			heartbeat_at: new Date().toISOString()
		});
	}
	return { done: false, text: finalText, consumedTokens: input.consumedTokens };
}

/** Drive one durable agent turn: compact, replay, apply, verify, or fold. */
async function runDurableAgentLoop(input: {
	readonly spec: AgentAutomationSpec;
	readonly messages: AiMessage[];
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly depth: number;
	readonly planMode: boolean;
	readonly goalMode: boolean;
	readonly userRequest: string;
	readonly verifierPrompt: string;
}): Promise<LoopResult> {
	const resolved = await resolveTools(input.spec, {
		canSpawnSubagent: input.depth === 0 && !input.planMode,
		planMode: input.planMode
	});
	const systemPrompt = composeSystemPrompt(input.spec.systemPrompt);
	const contextLength = input.depth === 0 ? await selectedModelContextLength(input.spec) : null;
	let consumedTokens = 0;
	let finalText = '';
	let compactionUnavailable = input.depth !== 0;
	while (true) {
		const pruned = pruneToolResultsInWindow(input.messages);
		if (pruned.some((message, index) => message !== input.messages[index])) {
			input.messages.splice(0, input.messages.length, ...pruned);
		}
		if (
			!compactionUnavailable &&
			input.messages.length >= COMPACTION_FLOOR_MESSAGES &&
			shouldAutomaticallyCompact({
				messages: input.messages,
				tools: resolved.specs,
				systemPrompt,
				contextLength
			})
		) {
			try {
				await compactDurableWindow({
					messages: input.messages,
					writer: input.writer,
					turnId: input.turnId,
					spec: input.spec,
					contextLength
				});
			} catch (cause) {
				if (automationReplayStorage.getStore()?.pending) throw cause;
				compactionUnavailable = true;
			}
		}
		const result = replayProviderTurn({
			messages: input.messages,
			tools: resolved.specs,
			spec: input.spec,
			planMode: input.planMode,
			goalMode: input.goalMode
		});
		const applied = await applySettledProviderTurn({
			spec: input.spec,
			resolved,
			messages: input.messages,
			writer: input.writer,
			turnId: input.turnId,
			depth: input.depth,
			planMode: input.planMode,
			result,
			consumedTokens
		});
		consumedTokens = applied.consumedTokens;
		if (applied.text) finalText = applied.text;
		if (applied.done) {
			if (applied.waiting) {
				return { text: finalText, consumedTokens };
			}
			if (
				await continueAfterGoalVerification({
					goalMode: input.goalMode,
					depth: input.depth,
					userRequest: input.userRequest,
					messages: input.messages,
					spec: input.spec,
					writer: input.writer,
					turnId: input.turnId,
					verifierPrompt: input.verifierPrompt
				})
			) {
				continue;
			}
			await foldSettledPlanWindow({
				foldAsCheckpoint: input.planMode,
				messages: input.messages,
				writer: input.writer,
				turnId: input.turnId,
				spec: input.spec
			});
			return { text: finalText, consumedTokens };
		}
	}
}

/** Run a child turn under the same session and return its text. */
async function runDurableSubagent(input: {
	readonly spec: AgentAutomationSpec;
	readonly task: string;
	readonly writer: TranscriptWriter;
	readonly parentTurnId: string;
	readonly subagentId: string;
	readonly depth: number;
	readonly planMode: boolean;
}): Promise<{ readonly text: string; readonly turnId: string }> {
	const session = await readChatSession(input.writer.sessionId);
	const existing = session.turns.find((turn) => turn.subagent_id === input.subagentId);
	const turnId = existing?.norbital_id ?? (await createTurn(input));
	const hasPrompt = session.messages.some(
		(message) => message.turn_id === turnId && message.role === 'user'
	);
	if (!hasPrompt) {
		const prompt: AiMessage = { role: 'user', content: input.task };
		const promptMessageId = await input.writer.persist(prompt, turnId);
		if (promptMessageId) {
			await updateChatTurn(input.writer.sessionId, turnId, {
				prompt_message_id: promptMessageId
			});
		}
	}
	try {
		const result = await runDurableAgentLoop({
			spec: input.spec,
			messages: [{ role: 'user', content: input.task }],
			writer: input.writer,
			turnId,
			depth: input.depth,
			planMode: input.planMode,
			goalMode: false,
			userRequest: input.task,
			verifierPrompt: ''
		});
		await finishTurn(input.writer.sessionId, turnId, 'succeeded');
		return { text: result.text, turnId };
	} catch (cause) {
		if (automationReplayStorage.getStore()?.pending) throw cause;
		const message = cause instanceof Error ? cause.message : String(cause);
		try {
			await finishTurn(input.writer.sessionId, turnId, 'failed', message);
		} catch (settlementCause) {
			throw combinedTurnFailure(cause, settlementCause);
		}
		throw cause;
	}
}

/** Mark the run and turn succeeded, deliver a channel reply when present, and resume waiters. */
async function completeDurableRun(input: {
	readonly ctx: ReturnType<typeof getWorkspace>;
	readonly runId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly text: string;
	readonly inputMessageId?: string | null;
	readonly channel?: DurableAgentChannelDelivery;
}): Promise<AgentRunResult> {
	await finishTurn(input.sessionId, input.turnId, 'succeeded');
	await updateRecord(
		input.ctx,
		'automation_run',
		input.runId,
		{
			status: 'success',
			output: { text: input.text },
			error: null,
			completed_at: new Date().toISOString()
		},
		{ isElevated: true }
	);
	if (input.channel) {
		const text = input.text.trim();
		const messaging = requireRuntimeFacility('messaging');
		const delivered = text
			? await messaging.sendVia(input.channel.channelKey, input.channel.transport, {
					conversationId: input.channel.conversationId,
					text
				})
			: { sent: false, reason: 'agent produced no text' };
		await updateRecord(
			input.ctx,
			'channel_inbound_message',
			input.channel.inboundReceiptId,
			{
				status: 'answered',
				answered_at: new Date().toISOString(),
				...(input.inputMessageId ? { session_message_id: input.inputMessageId } : {}),
				...(delivered.sent ? {} : { error: delivered.reason ?? 'transport refused delivery' })
			},
			{ isElevated: true }
		);
		await updateRecord(
			input.ctx,
			'channel_conversation',
			input.channel.conversationRowId,
			{
				last_inbound_at: new Date().toISOString(),
				...(delivered.sent ? { last_outbound_at: new Date().toISOString() } : {})
			},
			{ isElevated: true }
		);
	}
	await resumeSandboxWaiters(input.sessionId);
	return {
		runId: input.runId,
		status: 'success',
		text: input.text,
		sessionId: input.sessionId,
		inputMessageId: null
	};
}

/** Persist the failure, settle usage, and fail a channel inbound receipt when present. */
async function failDurableRun(input: {
	readonly ctx: ReturnType<typeof getWorkspace>;
	readonly writer: TranscriptWriter;
	readonly runId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly cause: unknown;
	readonly channel?: DurableAgentChannelDelivery;
}): Promise<never> {
	const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
	await input.writer
		.persist({ role: 'system', content: message }, input.turnId)
		.catch(() => undefined);
	let surfaced: unknown = input.cause;
	try {
		await finishTurn(input.sessionId, input.turnId, 'failed', message);
	} catch (settlementCause) {
		surfaced = combinedTurnFailure(input.cause, settlementCause);
	}
	await updateRecord(
		input.ctx,
		'automation_run',
		input.runId,
		{
			status: 'failed',
			error: message,
			completed_at: new Date().toISOString()
		},
		{ isElevated: true }
	).catch(() => undefined);
	if (input.channel) {
		await updateRecord(
			input.ctx,
			'channel_inbound_message',
			input.channel.inboundReceiptId,
			{ status: 'failed', error: message },
			{ isElevated: true }
		).catch(() => undefined);
	}
	await resumeSandboxWaiters(input.sessionId).catch(() => undefined);
	throw surfaced;
}

/**
 * Persist the user message and open the running turn before the host admits the receipt.
 */
export async function prepareInteractiveAgentTurn(input: {
	readonly sessionId: string;
	readonly spec: AgentAutomationSpec;
	readonly message: string;
	readonly planMode?: boolean;
	readonly goalMode?: boolean;
	readonly intent?: 'do' | 'plan';
	readonly verifierPrompt?: string;
	readonly mentions?: readonly AgentMentionInput[];
	readonly inputMetadata?: Record<string, unknown>;
}): Promise<{
	readonly turnId: string;
	readonly promptContent: string;
	readonly inputMessageId: string | null;
}> {
	const ctx = getWorkspace({ provision: true });
	const mentionContext = input.mentions?.length
		? await composeMentionContext(ctx, input.mentions)
		: null;
	const promptContent = mentionContext ? `${input.message}\n\n${mentionContext}` : input.message;
	const resolved = resolveAgentIntent({
		intent: input.intent,
		planMode: input.planMode,
		verifierPrompt: input.verifierPrompt,
		message: input.message,
		mentionCount: input.mentions?.length
	});
	const opened = await openInteractiveAgentTurn({
		sessionId: input.sessionId,
		model: input.spec.model ?? 'host-default',
		userMessage: input.message,
		userExtra: {
			...(input.inputMetadata ?? {}),
			...(resolved.planMode ? { plan_mode: true } : {}),
			...(resolved.verify ? { goal_mode: true } : {})
		},
		...(resolved.verify
			? {
					systemMessages: [
						{
							content: serializeVerifierScheduled(resolved.verifierPrompt),
							extra: { kind: 'goal' }
						}
					]
				}
			: {})
	});
	return { turnId: opened.turnId, promptContent, inputMessageId: opened.inputMessageId };
}

/**
 * Resume or start a durable agent turn from an automation receipt replay context.
 */
export async function runDurableAgentAutomation(input: {
	readonly automationName: string | null;
	readonly spec: AgentAutomationSpec;
	readonly scope?: Record<string, unknown>;
	readonly snapshot?: DurableAgentTurnSnapshot | null;
}): Promise<Record<string, unknown>> {
	if (!automationReplayStorage.getStore()) {
		throw new Error('Durable agent turns require an automation receipt replay context');
	}
	return withOriginRequestor(input.scope, async () => {
		const ctx = getWorkspace({ provision: true });
		const ownerUserId = ctx.baseScope.requestor.norbital_id;
		const snapshot = input.snapshot;
		const jobId = automationReplayStorage.getStore()?.jobId;
		const runId =
			snapshot?.runId ??
			jobId ??
			(
				await createRecord(
					ctx,
					'automation_run',
					{
						requested_by_user_id: ownerUserId,
						automation_name: input.automationName,
						status: 'running',
						input: { task: input.spec.task },
						started_at: new Date().toISOString()
					},
					{ isElevated: true, ...(jobId ? { recordId: jobId } : {}) }
				)
			).norbital_id;
		if (typeof runId !== 'string') throw new Error('Agent run has no id');
		if (snapshot?.runId || jobId) {
			const existing = await ctx.tenantDb.query<{
				automation_name: string | null;
				requested_by_user_id: string;
			}>(
				`SELECT automation_name, requested_by_user_id
				   FROM automation_run
				  WHERE norbital_id = $1::uuid`,
				[runId]
			);
			if (existing.rows[0]) {
				await updateRecord(
					ctx,
					'automation_run',
					runId,
					{ status: 'running', error: null, completed_at: null },
					{ isElevated: true }
				);
			} else {
				await createRecord(
					ctx,
					'automation_run',
					{
						requested_by_user_id: ownerUserId,
						automation_name: input.automationName,
						status: 'running',
						input: { task: input.spec.task },
						started_at: new Date().toISOString()
					},
					{ isElevated: true, recordId: runId }
				);
			}
		}
		const sessionId = snapshot?.sessionId ?? (await ensureRunSession(runId, ownerUserId));
		const writer = createTranscriptWriter(sessionId);
		const spec =
			input.automationName === null
				? await interactiveAgentSpec(
						snapshot?.input ?? snapshot?.promptContent ?? input.spec.task,
						snapshot?.spec.model ?? input.spec.model
					)
				: (snapshot?.spec ?? input.spec);
		const resolved = resolveAgentIntent({
			intent: snapshot?.intent,
			planMode: snapshot?.planMode,
			verifierPrompt: snapshot?.verifierPrompt,
			message: snapshot?.input ?? snapshot?.promptContent
		});
		const planMode = resolved.planMode;
		const goalMode = resolved.verify;
		const incoming = asRecord(input.scope?.incoming_record);
		const authoredRecord =
			snapshotFromRecord(incoming) === null && Object.keys(incoming).length > 0 ? incoming : null;
		const promptContent =
			snapshot?.promptContent ??
			(authoredRecord ? `${spec.task}\n\n${JSON.stringify(authoredRecord)}` : spec.task);
		const session = await readChatSession(sessionId);
		const openRootTurn = session.turns.find(
			(turn) => turn.subagent_id === null && turn.ended_at === null
		);
		const turnId =
			snapshot?.turnId ?? openRootTurn?.norbital_id ?? (await createTurn({ writer, spec }));
		const hasUserMessage = session.messages.some(
			(message) => message.turn_id === turnId && message.role === 'user'
		);
		if (!hasUserMessage) {
			const inputMessageId = await writer.persist(
				{ role: 'user', content: snapshot?.input ?? spec.task },
				turnId,
				{
					...(snapshot?.inputMetadata ?? {}),
					...(planMode ? { plan_mode: true } : {}),
					...(resolved.verify ? { goal_mode: true } : {})
				}
			);
			if (inputMessageId) {
				await updateChatTurn(sessionId, turnId, { prompt_message_id: inputMessageId });
			}
			if (resolved.verify) {
				await writer.persist(
					{ role: 'system', content: serializeVerifierScheduled(resolved.verifierPrompt) },
					turnId,
					{ kind: 'goal' }
				);
			}
		}
		let messages: Awaited<ReturnType<typeof loadDurableTurnWindow>>;
		try {
			messages = await loadDurableTurnWindow(sessionId, turnId, promptContent);
			if (messages.length === 0) throw new Error('Agent run requires an input message');
		} catch (cause) {
			if (automationReplayStorage.getStore()?.pending) throw cause;
			return failDurableRun({
				ctx,
				writer,
				runId,
				sessionId,
				turnId,
				cause,
				...(snapshot?.channel ? { channel: snapshot.channel } : {})
			});
		}

		if (snapshot?.compact) {
			const window = messages.slice(0, -1);
			try {
				const notice =
					window.length < COMPACTION_FLOOR_MESSAGES
						? 'There is not enough conversation to compact yet.'
						: await compactDurableWindow({
								messages: window,
								writer,
								turnId,
								spec,
								...(snapshot.compact.instructions
									? { instructions: snapshot.compact.instructions }
									: {})
							}).then(
								() => 'Context compacted. The conversation above is kept and still readable.'
							);
				if (window.length < COMPACTION_FLOOR_MESSAGES) {
					await writer.persist({ role: 'system', content: notice }, turnId);
				}
				const completed = await completeDurableRun({
					ctx,
					runId,
					sessionId,
					turnId,
					text: notice,
					...(snapshot.inputMessageId ? { inputMessageId: snapshot.inputMessageId } : {}),
					...(snapshot.channel ? { channel: snapshot.channel } : {})
				});
				return { text: completed.text, runId: completed.runId, sessionId: completed.sessionId };
			} catch (cause) {
				if (automationReplayStorage.getStore()?.pending) throw cause;
				return failDurableRun({
					ctx,
					writer,
					runId,
					sessionId,
					turnId,
					cause,
					...(snapshot.channel ? { channel: snapshot.channel } : {})
				});
			}
		}

		try {
			const result = await runDurableAgentLoop({
				spec,
				messages,
				writer,
				turnId,
				depth: 0,
				planMode,
				goalMode,
				userRequest: promptContent,
				verifierPrompt: resolved.verifierPrompt
			});
			const completed = await completeDurableRun({
				ctx,
				runId,
				sessionId,
				turnId,
				text: result.text,
				...(snapshot?.inputMessageId ? { inputMessageId: snapshot.inputMessageId } : {}),
				...(snapshot?.channel ? { channel: snapshot.channel } : {})
			});
			return { text: completed.text, runId: completed.runId, sessionId: completed.sessionId };
		} catch (cause) {
			if (automationReplayStorage.getStore()?.pending) throw cause;
			return failDurableRun({
				ctx,
				writer,
				runId,
				sessionId,
				turnId,
				cause,
				...(snapshot?.channel ? { channel: snapshot.channel } : {})
			});
		}
	});
}

/** Read a durable interactive or channel snapshot from an automation job's incoming record. */
export function durableAgentSnapshotFromScope(
	scope: Record<string, unknown> | undefined
): DurableAgentTurnSnapshot | null {
	return snapshotFromRecord(scope?.incoming_record);
}
