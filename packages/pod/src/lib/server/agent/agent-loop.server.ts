import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import type { AgentToolDefinition } from '$lib/authoring/automations/agent-tools.js';
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
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import type {
	AiChatResult,
	AiMessage,
	AiToolCall,
	AiToolSpec
} from '@norbital-ai/platform-utils/runtime/binding';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const readInput = z.object({
	collection: z.string(),
	where: recordSchema.optional(),
	limit: z.number().int().min(1).max(250).optional()
});
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

type AgentRunOptions = {
	readonly automationName: string | null;
	readonly spec: AgentAutomationSpec;
	readonly input?: string;
	readonly runId?: string;
	/**
	 * Continue an existing transcript instead of one keyed to this run.
	 *
	 * An automation's transcript begins and ends with its run, so the session can be derived from the
	 * run id. A channel conversation is the other shape: it outlives every run, and the second message
	 * from the same chat has to see the first. Passing the session says which transcript this run
	 * appends to, and the run row stays what it always was — the record of one turn.
	 */
	readonly sessionId?: string;
	/**
	 * How many trailing messages of an existing transcript to replay. Ignored without `sessionId`.
	 *
	 * A channel conversation has no end, so replaying all of it would grow every prompt until the
	 * model refused it. The window is trimmed to start at a `user` message: cutting between an
	 * assistant's tool call and its result leaves an orphaned result, which providers reject.
	 */
	readonly historyLimit?: number;
	/** Extra `chat_message` columns for the input message only — where it came from, and from whom. */
	readonly inputMetadata?: Record<string, unknown>;
	/**
	 * Compact the window before this turn reasons, whatever its size.
	 *
	 * Set by `/compact`. `instructions` steers what the summary keeps; it is the caller's words, not a
	 * prompt fragment this package composes.
	 */
	readonly compact?: { readonly instructions?: string };
};

/**
 * A directive typed into the composer rather than a message for the model.
 *
 * Matched on the whole message, not a prefix: `/compacting the schema` is a sentence, and treating
 * anything merely starting with the word as a command would swallow it. Bare `/compact` is what Core
 * matched; the trailing instructions are new, and must be separated by whitespace to count.
 */
const COMPACT_DIRECTIVE = /^\/compact(?:\s+([\s\S]+))?$/;

export function parseCompactDirective(message: string): { readonly instructions?: string } | null {
	const match = COMPACT_DIRECTIVE.exec(message.trim());
	if (!match) return null;
	const instructions = match[1]?.trim();
	return instructions ? { instructions } : {};
}

/**
 * When the window is large enough to be worth replacing with a summary.
 *
 * A character estimate, deliberately: this decides whether to spend a summarisation call, and being
 * wrong costs one call. It is never shown to anyone — a number a reader sees comes from the
 * provider's own accounting on `chat_message.usage`, never from this.
 */
function estimateTokens(messages: readonly AiMessage[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Leaves room for the turn's own reasoning inside the window the summary has to fit. */
const COMPACTION_TRIGGER_TOKENS = 120_000;

/** Below this there is nothing a summary would usefully replace. */
const COMPACTION_FLOOR_MESSAGES = 4;

type TranscriptWriter = {
	readonly sessionId: string;
	persist(
		message: AiMessage,
		turnId: string,
		extra?: Record<string, unknown>
	): Promise<string | null>;
	update(messageId: string, values: Record<string, unknown>): Promise<void>;
};

function objectValue(value: unknown): Record<string, unknown> {
	return recordSchema.safeParse(value).success ? (value as Record<string, unknown>) : { value };
}

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

function tenantCollectionNames(): string[] {
	return Object.values(getTenantManifest().collections)
		.filter((collection) => collection.system !== true)
		.map((collection) => collection.collection_name)
		.sort();
}

/**
 * The collections this run may name, narrowed by its spec.
 *
 * Not the security boundary: `read_collection` goes through `findMany` without elevation, so the
 * requestor's policy decides what actually comes back. This narrows on top of that, so an agent
 * declared for `quotes` cannot wander into `accounts` even where its requestor could.
 */
function allowedCollections(spec: AgentAutomationSpec): Set<string> {
	const all = tenantCollectionNames();
	const selected = spec.collections ? [...spec.collections] : all;
	const unknown = selected.filter((collection) => !all.includes(collection));
	if (unknown.length > 0) {
		throw new Error(`Agent references unknown collections: ${unknown.join(', ')}`);
	}
	return new Set(selected);
}

function jsonSchema(definition: AgentToolDefinition): unknown {
	return z.toJSONSchema(definition.input);
}

/**
 * What one run may call, resolved once.
 *
 * `hostTools` is a *set*, not a list to search: dispatch has to ask "is this name a host tool this
 * run was granted" and nothing else. Resolving it up front is also what makes the host's `list()` one
 * call per run rather than one per tool call.
 */
type ResolvedTools = {
	readonly specs: readonly AiToolSpec[];
	readonly hostTools: ReadonlySet<string>;
};

/**
 * The host tools this run may call, described for the model.
 *
 * Default deny, and the deny is structural: nothing is added unless `spec.hostTools` names it. A host
 * tool runs in the host process holding host credentials, so it is not something an agent should
 * inherit by being an agent — the workspace has to have said so, in source, per agent.
 *
 * The shadow check is repeated here rather than left to `assertHostAgentTools` at startup. That gate
 * is the one that produces a good message at a good time, but it belongs to the host, and Core is a
 * host this package does not run. A collision that slipped past it must still fail loudly before any
 * model call, not resolve to whichever branch of `executeTool` is reached first.
 */
async function hostToolSpecs(
	spec: AgentAutomationSpec,
	taken: ReadonlySet<string>
): Promise<readonly AiToolSpec[]> {
	const named = spec.hostTools ?? [];
	if (named.length === 0) return [];
	const binding = requireRuntimeFacility('agentTools');
	const available = new Map((await binding.list()).map((tool) => [tool.name, tool]));
	return named.map((name) => {
		const tool = available.get(name);
		if (!tool) throw new Error(`Agent references unknown host tool: ${name}`);
		if (taken.has(name)) {
			throw new Error(
				`Host tool ${name} collides with a workspace tool of the same name; the agent cannot tell them apart`
			);
		}
		return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
	});
}

async function resolveTools(
	spec: AgentAutomationSpec,
	options: { readonly canSpawnSubagent: boolean }
): Promise<ResolvedTools> {
	const collections = allowedCollections(spec);
	const tools: AiToolSpec[] = [
		{
			name: 'describe_workspace',
			description: 'Describe the workspace schema and the collections relevant to this run.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false }
		},
		{
			name: 'read_collection',
			description: 'Read policy-visible records from an allowed collection.',
			inputSchema: z.toJSONSchema(readInput)
		}
	];
	if (options.canSpawnSubagent) {
		tools.push({
			name: 'spawn_subagent',
			description:
				'Spawn one focused subagent for a delegated task. The child uses the same approved data and workspace tools, streams its own transcript, and returns its final answer.',
			inputSchema: {
				type: 'object',
				properties: {
					task: { type: 'string', minLength: 1 }
				},
				required: ['task'],
				additionalProperties: false
			}
		});
	}
	if ((spec.access ?? 'read') === 'write') {
		tools.push({
			name: 'write_collection',
			description: 'Create, update, or delete records through Pod collection operations.',
			// OpenAI-compatible providers require function parameters to have an object root.
			// `z.discriminatedUnion()` emits a root `oneOf`, so advertise the shared envelope here
			// and keep `writeInput.parse()` below as the stricter per-action execution boundary.
			inputSchema: {
				type: 'object',
				properties: {
					collection: { type: 'string' },
					action: { type: 'string', enum: ['create', 'update', 'delete'] },
					id: { type: 'string', format: 'uuid' },
					record: { type: 'object', additionalProperties: true }
				},
				required: ['collection', 'action'],
				additionalProperties: false
			}
		});
	}
	const registered = getTenantWorkspace().registered.agentTools;
	for (const name of spec.tools ?? []) {
		const definition = registered[name];
		if (!definition) throw new Error(`Agent references unknown tenant tool: ${name}`);
		tools.push({ name, description: definition.description, inputSchema: jsonSchema(definition) });
	}
	const taken = new Set(tools.map((tool) => tool.name));
	const hostSpecs = await hostToolSpecs(spec, taken);
	tools.push(...hostSpecs);
	void collections;
	return { specs: tools, hostTools: new Set(hostSpecs.map((tool) => tool.name)) };
}

const MUTATION_METHODS = new Set(['create', 'update', 'delete']);

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

async function executeTool(
	spec: AgentAutomationSpec,
	resolved: ResolvedTools,
	call: AiToolCall
): Promise<Record<string, unknown>> {
	const ctx = getWorkspace({ provision: true });
	const collections = allowedCollections(spec);
	if (call.name === 'describe_workspace') {
		return {
			manifest: getTenantManifest(),
			relevantCollections: [...collections]
		};
	}
	if (call.name === 'read_collection') {
		const input = readInput.parse(call.input);
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
		return objectValue(await binding.run(call.name, call.input));
	}
	const definition = getTenantWorkspace().registered.agentTools[call.name];
	if (!definition || !(spec.tools ?? []).includes(call.name)) {
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

/**
 * Replay a transcript.
 *
 * Each row stores one `AiMessage` verbatim, so replay is a read rather than a reconstruction — the
 * previous shape spread a single assistant turn across `tool_call` rows and rebuilt it on load, which
 * meant the stored form and the in-memory form could disagree.
 *
 * Keyed by run for an automation and by session for a channel: the two differ only in which rows are
 * "this conversation so far", which is exactly what the `WHERE` decides.
 */
async function loadMessages(
	scope: { readonly runId: string } | { readonly sessionId: string; readonly limit?: number }
): Promise<{ messages: AiMessage[]; sequence: number }> {
	const ctx = getWorkspace({ provision: true });
	// A compaction checkpoint is a durable, explicit floor for the window. Resolving it from a stored
	// column means two runs over the same transcript build the same window, where the recency limit
	// below moves under the conversation as it grows and drops history with no record of having done
	// it. Subagent rows are excluded here exactly as they are from every other window query.
	const anchor =
		'sessionId' in scope
			? await ctx.tenantDb.query<{ seq: number | null }>({
					text: `SELECT MAX(m.seq) AS seq
					         FROM chat_message m
					    LEFT JOIN chat_turn t ON t.norbital_id = m.turn_id
					        WHERE m.chat_id = $1::uuid
					          AND m.kind = 'summary'
					          AND (m.turn_id IS NULL OR t.subagent_id IS NULL)`,
					values: [scope.sessionId]
				})
			: null;
	const anchorSeq = anchor?.rows[0]?.seq ?? null;
	// A window is only meaningful for a session — a run's transcript is bounded by the run itself.
	const query =
		'runId' in scope
			? {
					text: `SELECT m.seq, m.parts, m.kind
					         FROM chat_message m
					         JOIN chat_session s ON s.norbital_id = m.chat_id
					    LEFT JOIN chat_turn t ON t.norbital_id = m.turn_id
					        WHERE s.automation_run_id = $1::uuid
					          AND (m.turn_id IS NULL OR t.subagent_id IS NULL)
					        ORDER BY m.seq`,
					values: [scope.runId]
				}
			: anchorSeq !== null
				? {
						// From the checkpoint forward, unbounded: the summary stands in for everything below
						// it, and re-limiting on top would drop turns the checkpoint promised were kept.
						text: `SELECT m.seq, m.parts, m.kind FROM chat_message m
						    LEFT JOIN chat_turn t ON t.norbital_id = m.turn_id
						        WHERE m.chat_id = $1::uuid
						          AND m.seq >= $2
						          AND (m.turn_id IS NULL OR t.subagent_id IS NULL)
						        ORDER BY m.seq`,
						values: [scope.sessionId, anchorSeq]
					}
				: {
						text: `SELECT seq, parts, kind FROM (
						         SELECT m.seq, m.parts, m.kind FROM chat_message m
						          LEFT JOIN chat_turn t ON t.norbital_id = m.turn_id
						          WHERE m.chat_id = $1::uuid
						            AND (m.turn_id IS NULL OR t.subagent_id IS NULL)
						          ORDER BY seq DESC
						          LIMIT $2
						       ) recent ORDER BY seq`,
						values: [scope.sessionId, scope.limit ?? 40]
					};
	const result = await ctx.tenantDb.query<{
		seq: number;
		parts: AiMessage[] | null;
		kind: string | null;
	}>(query);
	const messages: AiMessage[] = [];
	for (const row of result.rows) {
		const message = row.parts?.[0];
		if (!message) continue;
		// A checkpoint re-enters the window as the user's own recap rather than as the system message it
		// is stored as. It has to read as conversation the model may rely on, and a window opening on a
		// `system` role beside the spec's own system prompt is two different things claiming one voice.
		messages.push(
			row.kind === 'summary'
				? {
						role: 'user',
						content: `<conversation-summary>\n${message.content}\n</conversation-summary>`
					}
				: message
		);
	}
	// The next sequence number comes from the whole transcript, never from the window: numbering from
	// the window would reuse sequence numbers and reorder the stored conversation.
	const highest =
		'runId' in scope
			? { rows: [{ seq: result.rows.at(-1)?.seq ?? 0 }] }
			: await ctx.tenantDb.query<{ seq: number }>({
					text: `SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_message WHERE chat_id = $1::uuid`,
					values: [scope.sessionId]
				});
	if ('sessionId' in scope && anchorSeq === null) {
		// Only without a checkpoint. A window that opens on a `tool` result carries a result whose call
		// was cut away, and a provider rejects the whole request rather than ignoring it — so the
		// recency window is aligned to a user message. A checkpoint already opens on one by
		// construction, and re-aligning would skip past the summary itself.
		const start = messages.findIndex((message) => message.role === 'user');
		messages.splice(0, start === -1 ? messages.length : start);
	}
	return { messages, sequence: Number(highest.rows[0]?.seq ?? 0) };
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

function createTranscriptWriter(input: {
	readonly sessionId: string;
	readonly startingSequence: number;
}): TranscriptWriter {
	const ctx = getWorkspace({ provision: true });
	let sequence = input.startingSequence;
	return {
		sessionId: input.sessionId,
		async persist(message, turnId, extra): Promise<string | null> {
			sequence += 1;
			const record = await createRecord(
				ctx,
				'chat_message',
				{
					chat_id: input.sessionId,
					turn_id: turnId,
					role: message.role,
					seq: sequence,
					parts: [message],
					...(extra ?? {})
				},
				{ isElevated: true }
			);
			return typeof record.norbital_id === 'string' ? record.norbital_id : null;
		},
		async update(messageId, values): Promise<void> {
			await updateRecord(ctx, 'chat_message', messageId, values, { isElevated: true });
		}
	};
}

async function createTurn(input: {
	readonly writer: TranscriptWriter;
	readonly spec: AgentAutomationSpec;
	readonly parentTurnId?: string;
	readonly subagentId?: string;
}): Promise<string> {
	const ctx = getWorkspace({ provision: true });
	const turn = await createRecord(
		ctx,
		'chat_turn',
		{
			chat_id: input.writer.sessionId,
			status: 'running',
			model: input.spec.model ?? 'host-default',
			...(input.parentTurnId ? { parent_turn_id: input.parentTurnId } : {}),
			...(input.subagentId ? { subagent_id: input.subagentId } : {})
		},
		{ isElevated: true }
	);
	if (typeof turn.norbital_id !== 'string') throw new Error('Agent turn has no id');
	return turn.norbital_id;
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
 * One statement, so the claim and the increment cannot come apart: the `UPDATE ... WHERE
 * usage_settled_at IS NULL` is the idempotency gate, and a second attempt at the same turn updates
 * no row and therefore adds nothing. Compaction is invisible to this by construction — a checkpoint
 * changes which messages the model is sent, not which ones were paid for, and the summariser's own
 * usage is persisted onto the checkpoint row so it is counted like any other call.
 */
async function settleTurnUsage(turnId: string): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	const rows = await ctx.tenantDb.query<{ usage: unknown }>({
		text: `SELECT usage FROM chat_message WHERE turn_id = $1::uuid AND usage IS NOT NULL`,
		values: [turnId]
	});
	let tokens = 0;
	let cost = 0;
	let reported = false;
	let unreported = false;
	for (const row of rows.rows) {
		const spend = messageSpend(row.usage);
		tokens += spend.tokens;
		if (spend.cost === null) unreported = true;
		else {
			cost += spend.cost;
			reported = true;
		}
	}
	// A turn that produced no accounting at all still counts as unreported: the request happened.
	if (!reported) unreported = true;
	const settled = await ctx.tenantDb.query<{ chat_id: string }>({
		text: `UPDATE chat_turn
		          SET usage_settled_at = now()
		        WHERE norbital_id = $1::uuid
		          AND usage_settled_at IS NULL
		    RETURNING chat_id`,
		values: [turnId]
	});
	const chatId = settled.rows[0]?.chat_id;
	if (typeof chatId !== 'string') return;
	const totals = await ctx.tenantDb.query<{
		usage_cost_usd: number;
		usage_total_tokens: number;
		usage_turns_counted: number;
		usage_turns_unreported: number;
	}>({
		text: `UPDATE chat_session
		          SET usage_cost_usd = usage_cost_usd + $2,
		              usage_total_tokens = usage_total_tokens + $3,
		              usage_turns_counted = usage_turns_counted + 1,
		              usage_turns_unreported = usage_turns_unreported + $4
		        WHERE norbital_id = $1::uuid
		    RETURNING usage_cost_usd, usage_total_tokens, usage_turns_counted, usage_turns_unreported`,
		values: [chatId, cost, tokens, unreported ? 1 : 0]
	});
	const row = totals.rows[0];
	if (!row) return;
	// The increment above is authoritative and atomic; this republishes the same numbers through the
	// ordinary write path so the sync outbox carries them to the reader, who otherwise would never
	// see a counter that only ever moved by raw SQL.
	await updateRecord(ctx, 'chat_session', chatId, { ...row }, { isElevated: true }).catch(
		() => undefined
	);
}

async function finishTurn(
	turnId: string,
	status: 'succeeded' | 'failed' | 'aborted',
	error?: string
): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	await updateRecord(
		ctx,
		'chat_turn',
		turnId,
		{
			status,
			heartbeat_at: new Date().toISOString(),
			ended_at: new Date().toISOString(),
			error: error ?? null
		},
		{ isElevated: true }
	);
	// Every terminal status settles, not only success: a failed turn still spent whatever it spent
	// before it failed, and a total that ignored that would understate the conversation.
	await settleTurnUsage(turnId).catch(() => undefined);
}

type ProviderTurnResult = {
	readonly text: string;
	readonly toolCalls: readonly AiToolCall[];
	readonly stopReason: AiChatResult['stopReason'];
	readonly usage?: unknown;
};

/**
 * Pull one provider stream through the host boundary and make its text visible in tenant sync.
 *
 * The host owns only a short-lived event queue. The first text delta creates the assistant row and
 * every following batch updates that same row, so the replica observes a real `streaming` ->
 * `complete` transition without Core retaining a second copy of the conversation.
 */
async function streamProviderTurn(input: {
	readonly messages: readonly AiMessage[];
	readonly tools: readonly AiToolSpec[];
	readonly spec: AgentAutomationSpec;
	readonly writer: TranscriptWriter;
	readonly turnId: string;
}): Promise<ProviderTurnResult> {
	const ctx = getWorkspace({ provision: true });
	const ai = requireRuntimeFacility('ai');
	if (!ai.startStream || !ai.readStream || !ai.cancelStream) {
		const result = await ai.chat({
			messages: [
				...(input.spec.systemPrompt
					? [{ role: 'system' as const, content: input.spec.systemPrompt }]
					: []),
				...input.messages
			],
			tools: input.tools,
			...(input.spec.model ? { model: input.spec.model } : {}),
			...(input.spec.profile ? { profile: input.spec.profile } : {})
		});
		if (result.text) {
			await input.writer.persist({ role: 'assistant', content: result.text }, input.turnId, {
				status: 'complete',
				model: input.spec.model ?? null,
				...(result.usage ? { usage: objectValue(result.usage) } : {})
			});
		}
		return {
			text: result.text,
			toolCalls: result.toolCalls ?? [],
			stopReason: result.stopReason,
			...(result.usage !== undefined ? { usage: result.usage } : {})
		};
	}
	const streamId = await ai.startStream({
		messages: [
			...(input.spec.systemPrompt
				? [{ role: 'system' as const, content: input.spec.systemPrompt }]
				: []),
			...input.messages
		],
		tools: input.tools,
		...(input.spec.model ? { model: input.spec.model } : {}),
		...(input.spec.profile ? { profile: input.spec.profile } : {})
	});
	let text = '';
	let assistantMessageId: string | null = null;
	let stopReason: AiChatResult['stopReason'] = 'end';
	let usage: unknown;
	const toolCalls: AiToolCall[] = [];
	let done = false;
	let lastHeartbeat = Date.now();
	try {
		while (!done) {
			const batch = await ai.readStream(streamId);
			let textChanged = false;
			for (const event of batch.events) {
				if (event.type === 'text_delta') {
					text += event.delta;
					textChanged = true;
				} else if (event.type === 'tool_call') {
					toolCalls.push(event.call);
				} else {
					stopReason = event.stopReason;
					usage = event.usage;
				}
			}
			if (textChanged) {
				const message: AiMessage = { role: 'assistant', content: text };
				if (assistantMessageId) {
					await input.writer.update(assistantMessageId, { parts: [message], status: 'streaming' });
				} else {
					assistantMessageId = await input.writer.persist(message, input.turnId, {
						status: 'streaming',
						model: input.spec.model ?? null
					});
				}
			}
			if (Date.now() - lastHeartbeat >= 5_000) {
				lastHeartbeat = Date.now();
				await updateRecord(
					ctx,
					'chat_turn',
					input.turnId,
					{ heartbeat_at: new Date().toISOString() },
					{ isElevated: true }
				);
			}
			done = batch.done;
		}
		if (assistantMessageId) {
			await input.writer.update(assistantMessageId, {
				parts: [{ role: 'assistant', content: text }],
				status: 'complete',
				...(usage ? { usage: objectValue(usage) } : {})
			});
		}
		return { text, toolCalls, stopReason, ...(usage !== undefined ? { usage } : {}) };
	} catch (cause) {
		await ai.cancelStream(streamId).catch(() => undefined);
		if (assistantMessageId) {
			await input.writer
				.update(assistantMessageId, {
					parts: [{ role: 'assistant', content: text }],
					status: 'aborted'
				})
				.catch(() => undefined);
		}
		throw cause;
	}
}

/**
 * Replace a window with a summary of itself, and record that it happened.
 *
 * Nothing is deleted. The checkpoint is an ordinary `chat_message` with `kind = 'summary'`, and the
 * window builder starts from it — so the conversation below stays readable in full while the model
 * carries the recap. That is the whole trust property: history that leaves the model's view leaves a
 * durable mark in the transcript rather than falling silently out of a recency limit.
 */
async function compactWindow(input: {
	readonly messages: AiMessage[];
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly spec: AgentAutomationSpec;
	readonly instructions?: string;
}): Promise<string> {
	const ai = requireRuntimeFacility('ai');
	const steer = input.instructions
		? `\n\nThe person asked you to focus on: ${input.instructions}`
		: '';
	const result = await ai.chat({
		messages: [
			{
				role: 'user',
				content:
					'Summarize this agent conversation for faithful continuation. Preserve decisions, ' +
					'constraints, identifiers, tool outcomes, unresolved work, and the intent behind the ' +
					`request.${steer}\n\n${JSON.stringify(input.messages)}`
			}
		],
		...(input.spec.model ? { model: input.spec.model } : {}),
		...(input.spec.profile ? { profile: input.spec.profile } : {})
	});
	const summary = result.text.trim();
	if (!summary) throw new Error('The summarizer returned nothing to checkpoint');
	// The summariser's own usage rides on the checkpoint row, so compacting is counted like any other
	// call rather than being spend that never appears in the total.
	await input.writer.persist({ role: 'system', content: summary }, input.turnId, {
		kind: 'summary',
		...(result.usage ? { usage: objectValue(result.usage) } : {})
	});
	// The turn continues against the recap alone; everything it replaced is still in the transcript.
	input.messages.splice(0, input.messages.length, {
		role: 'user',
		content: `<conversation-summary>\n${summary}\n</conversation-summary>`
	});
	return summary;
}

type LoopResult = { readonly text: string; readonly consumedTokens: number };

async function runAgentLoop(input: {
	readonly spec: AgentAutomationSpec;
	readonly messages: AiMessage[];
	readonly writer: TranscriptWriter;
	readonly turnId: string;
	readonly depth: number;
	readonly iterationLimit?: number;
}): Promise<LoopResult> {
	const ctx = getWorkspace({ provision: true });
	const resolved = await resolveTools(input.spec, { canSpawnSubagent: input.depth === 0 });
	const maxIterations = input.iterationLimit ?? input.spec.maxIterations ?? 8;
	let consumedTokens = 0;
	let finalText = '';
	// Once per turn, and never for a subagent: a child's window is its task and one loop, and a
	// checkpoint written into the shared session from inside a child would anchor its parent too.
	let compacted = input.depth !== 0;
	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		if (
			!compacted &&
			input.messages.length >= COMPACTION_FLOOR_MESSAGES &&
			estimateTokens(input.messages) >= COMPACTION_TRIGGER_TOKENS
		) {
			compacted = true;
			// A failed summarisation must not fail the turn: the window it would have replaced is still
			// valid, and losing a conversation to a summariser outage is worse than a large prompt.
			await compactWindow({
				messages: input.messages,
				writer: input.writer,
				turnId: input.turnId,
				spec: input.spec
			}).catch(() => undefined);
		}
		const result = await streamProviderTurn({
			messages: input.messages,
			tools: resolved.specs,
			spec: input.spec,
			writer: input.writer,
			turnId: input.turnId
		});
		consumedTokens += usageTokens(result.usage);
		if (input.spec.maxTokens && consumedTokens > input.spec.maxTokens) {
			throw new Error(`Agent token budget exceeded (${input.spec.maxTokens})`);
		}
		if (result.text) {
			finalText = result.text;
			input.messages.push({ role: 'assistant', content: result.text });
		}
		const calls = result.toolCalls;
		if (calls.length > 0) {
			const callMessage: AiMessage = { role: 'assistant', content: '', toolCalls: calls };
			input.messages.push(callMessage);
			// An iteration that chose a tool instead of prose produces no text message, so its usage had
			// nowhere to be stored and was simply lost — the tokens were spent and nothing recorded it.
			// It belongs on the call message. Only when there was no text, or the accounting for one
			// provider round trip would be attached twice.
			await input.writer.persist(
				callMessage,
				input.turnId,
				!result.text && result.usage ? { usage: objectValue(result.usage) } : undefined
			);
		}
		if (calls.length === 0) {
			if (result.stopReason === 'refusal') throw new Error('AI provider refused the run');
			return { text: finalText, consumedTokens };
		}
		for (const call of calls) {
			let output: Record<string, unknown>;
			try {
				if (call.name === 'spawn_subagent') {
					if (input.depth !== 0) throw new Error('Subagents cannot spawn another subagent');
					const task = z.object({ task: z.string().min(1) }).parse(call.input).task;
					const child = await runSubagent({
						spec: input.spec,
						task,
						writer: input.writer,
						parentTurnId: input.turnId,
						subagentId: `subagent:${call.id}`,
						depth: input.depth + 1
					});
					output = { text: child.text, turnId: child.turnId };
				} else {
					output = await executeTool(input.spec, resolved, call);
				}
			} catch (cause) {
				output = { error: cause instanceof Error ? cause.message : String(cause) };
			}
			const toolMessage: AiMessage = {
				role: 'tool',
				content: JSON.stringify(output),
				toolCallId: call.id
			};
			input.messages.push(toolMessage);
			await input.writer.persist(toolMessage, input.turnId);
			await updateRecord(
				ctx,
				'chat_turn',
				input.turnId,
				{ heartbeat_at: new Date().toISOString() },
				{ isElevated: true }
			);
		}
	}
	throw new Error(`Agent exceeded maxIterations (${maxIterations})`);
}

async function runSubagent(input: {
	readonly spec: AgentAutomationSpec;
	readonly task: string;
	readonly writer: TranscriptWriter;
	readonly parentTurnId: string;
	readonly subagentId: string;
	readonly depth: number;
}): Promise<{ readonly text: string; readonly turnId: string }> {
	const ctx = getWorkspace({ provision: true });
	const turnId = await createTurn(input);
	const prompt: AiMessage = { role: 'user', content: input.task };
	const promptMessageId = await input.writer.persist(prompt, turnId);
	if (promptMessageId) {
		await updateRecord(
			ctx,
			'chat_turn',
			turnId,
			{ prompt_message_id: promptMessageId },
			{ isElevated: true }
		);
	}
	try {
		const result = await runAgentLoop({
			spec: input.spec,
			messages: [prompt],
			writer: input.writer,
			turnId,
			depth: input.depth,
			iterationLimit: Math.min(input.spec.maxIterations ?? 8, 4)
		});
		await finishTurn(turnId, 'succeeded');
		return { text: result.text, turnId };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		await finishTurn(turnId, 'failed', message).catch(() => undefined);
		throw cause;
	}
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
	const ctx = getWorkspace({ provision: true });
	const ownerUserId = ctx.baseScope.requestor.norbital_id;
	const startedAt = new Date().toISOString();
	const run = options.runId
		? { norbital_id: options.runId }
		: await createRecord(
				ctx,
				'automation_run',
				{
					requested_by_user_id: ownerUserId,
					automation_name: options.automationName,
					status: 'running',
					input: { task: options.spec.task },
					started_at: startedAt
				},
				{ isElevated: true }
			);
	const runId = run.norbital_id;
	if (typeof runId !== 'string') throw new Error('Agent run has no id');
	if (options.runId) {
		const existing = await ctx.tenantDb.query<{
			automation_name: string | null;
			requested_by_user_id: string;
		}>(
			`SELECT automation_name, requested_by_user_id
			   FROM automation_run
			  WHERE norbital_id = $1::uuid`,
			[runId]
		);
		if (!existing.rows[0]) throw new Error('Agent run does not exist');
		if (existing.rows[0].requested_by_user_id !== ownerUserId) {
			throw new Error('Agent run belongs to another requestor');
		}
		if (existing.rows[0].automation_name !== options.automationName) {
			throw new Error('Agent run does not match this automation');
		}
		await updateRecord(
			ctx,
			'automation_run',
			runId,
			{ status: 'running', error: null, completed_at: null },
			{ isElevated: true }
		);
	}
	const restored = await loadMessages(
		options.sessionId
			? {
					sessionId: options.sessionId,
					...(options.historyLimit ? { limit: options.historyLimit } : {})
				}
			: { runId }
	);
	const messages: AiMessage[] = [...restored.messages];
	const sessionId = options.sessionId ?? (await ensureRunSession(runId, ownerUserId));
	const writer = createTranscriptWriter({
		sessionId,
		startingSequence: restored.sequence
	});
	const turnId = await createTurn({ writer, spec: options.spec });
	const initial = options.input ?? (messages.length === 0 ? options.spec.task : undefined);
	let inputMessageId: string | null = null;
	if (initial) {
		messages.push({ role: 'user', content: initial });
		inputMessageId = await writer.persist(
			{ role: 'user', content: initial },
			turnId,
			options.inputMetadata
		);
		if (inputMessageId) {
			await updateRecord(
				ctx,
				'chat_turn',
				turnId,
				{ prompt_message_id: inputMessageId },
				{ isElevated: true }
			);
		}
	}
	if (messages.length === 0) throw new Error('Agent run requires an input message');

	// `/compact` is a directive about the conversation, not a prompt for the model. It finishes here
	// rather than running a turn — asking the agent to answer the word "/compact" would produce a
	// reply about nothing, on top of a window that had just been replaced under it.
	if (options.compact) {
		// The prompt itself is already stored above; drop it from what gets summarized so the recap is
		// of the conversation rather than of the request to summarize it.
		const window = messages.slice(0, -1);
		const notice =
			window.length < COMPACTION_FLOOR_MESSAGES
				? 'There is not enough conversation to compact yet.'
				: await compactWindow({
						messages: window,
						writer,
						turnId,
						spec: options.spec,
						...(options.compact.instructions ? { instructions: options.compact.instructions } : {})
					}).then(() => 'Context compacted. The conversation above is kept and still readable.');
		if (window.length < COMPACTION_FLOOR_MESSAGES) {
			await writer.persist({ role: 'system', content: notice }, turnId);
		}
		await finishTurn(turnId, 'succeeded');
		await updateRecord(
			ctx,
			'automation_run',
			runId,
			{
				status: 'success',
				output: { text: notice },
				error: null,
				completed_at: new Date().toISOString()
			},
			{ isElevated: true }
		);
		return { runId, status: 'success', text: notice, sessionId, inputMessageId };
	}

	try {
		const result = await runAgentLoop({
			spec: options.spec,
			messages,
			writer,
			turnId,
			depth: 0
		});
		await finishTurn(turnId, 'succeeded');
		await updateRecord(
			ctx,
			'automation_run',
			runId,
			{
				status: 'success',
				output: { text: result.text },
				error: null,
				completed_at: new Date().toISOString()
			},
			{ isElevated: true }
		);
		return { runId, status: 'success', text: result.text, sessionId, inputMessageId };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		await writer.persist({ role: 'system', content: message }, turnId).catch(() => undefined);
		await finishTurn(turnId, 'failed', message).catch(() => undefined);
		await updateRecord(
			ctx,
			'automation_run',
			runId,
			{
				status: 'failed',
				error: message,
				completed_at: new Date().toISOString()
			},
			{ isElevated: true }
		).catch(() => undefined);
		throw cause;
	}
}

export async function startInteractiveAgent(input: {
	readonly message: string;
	readonly runId?: string;
}): Promise<AgentRunResult> {
	return runAgent({
		automationName: null,
		runId: input.runId,
		input: input.message,
		spec: { kind: 'agent', task: input.message }
	});
}
