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

function toolSpecs(spec: AgentAutomationSpec): AiToolSpec[] {
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
	if ((spec.access ?? 'read') === 'write') {
		tools.push({
			name: 'write_collection',
			description: 'Create, update, or delete records through Pod collection operations.',
			inputSchema: z.toJSONSchema(writeInput)
		});
	}
	const registered = getTenantWorkspace().registered.agentTools;
	for (const name of spec.tools ?? []) {
		const definition = registered[name];
		if (!definition) throw new Error(`Agent references unknown tenant tool: ${name}`);
		tools.push({ name, description: definition.description, inputSchema: jsonSchema(definition) });
	}
	void collections;
	return tools;
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
	// A window is only meaningful for a session — a run's transcript is bounded by the run itself.
	const query =
		'runId' in scope
			? {
					text: `SELECT m.seq, m.parts
					         FROM chat_message m
					         JOIN chat_session s ON s.norbital_id = m.chat_id
					        WHERE s.automation_run_id = $1::uuid
					        ORDER BY m.seq`,
					values: [scope.runId]
				}
			: {
					text: `SELECT seq, parts FROM (
					         SELECT seq, parts FROM chat_message
					          WHERE chat_id = $1::uuid
					          ORDER BY seq DESC
					          LIMIT $2
					       ) recent ORDER BY seq`,
					values: [scope.sessionId, scope.limit ?? 40]
				};
	const result = await ctx.tenantDb.query<{ seq: number; parts: AiMessage[] | null }>(query);
	const messages: AiMessage[] = [];
	for (const row of result.rows) {
		const message = row.parts?.[0];
		if (message) messages.push(message);
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
	if ('sessionId' in scope) {
		// Start the window at a user message. A window that opens on a `tool` result carries a result
		// whose call was cut away, and a provider rejects the whole request rather than ignoring it.
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
	let sequence = restored.sequence;
	const messages: AiMessage[] = [...restored.messages];
	let sessionId: string | null = options.sessionId ?? null;
	const persist = async (
		message: AiMessage,
		extra?: Record<string, unknown>
	): Promise<string | null> => {
		sessionId ??= await ensureRunSession(runId, ownerUserId);
		sequence += 1;
		const record = await createRecord(
			ctx,
			'chat_message',
			{
				chat_id: sessionId,
				role: message.role,
				seq: sequence,
				parts: [message],
				...(extra ?? {})
			},
			{ isElevated: true }
		);
		return typeof record.norbital_id === 'string' ? record.norbital_id : null;
	};
	const initial = options.input ?? (messages.length === 0 ? options.spec.task : undefined);
	let inputMessageId: string | null = null;
	if (initial) {
		messages.push({ role: 'user', content: initial });
		inputMessageId = await persist({ role: 'user', content: initial }, options.inputMetadata);
	}
	if (messages.length === 0) throw new Error('Agent run requires an input message');

	const ai = requireRuntimeFacility('ai');
	const tools = toolSpecs(options.spec);
	const maxIterations = options.spec.maxIterations ?? 8;
	let consumedTokens = 0;
	let finalText = '';
	try {
		for (let iteration = 0; iteration < maxIterations; iteration += 1) {
			const result = await ai.chat({
				messages: [
					...(options.spec.systemPrompt
						? [{ role: 'system' as const, content: options.spec.systemPrompt }]
						: []),
					...messages
				],
				tools,
				...(options.spec.model ? { model: options.spec.model } : {}),
				...(options.spec.profile ? { profile: options.spec.profile } : {})
			});
			consumedTokens += usageTokens(result.usage);
			if (options.spec.maxTokens && consumedTokens > options.spec.maxTokens) {
				throw new Error(`Agent token budget exceeded (${options.spec.maxTokens})`);
			}
			if (result.text) {
				finalText = result.text;
				messages.push({ role: 'assistant', content: result.text });
				await persist(
					{ role: 'assistant', content: result.text },
					result.usage ? { usage: objectValue(result.usage) } : undefined
				);
			}
			const calls = result.toolCalls ?? [];
			if (calls.length > 0) {
				const call_message: AiMessage = { role: 'assistant', content: '', toolCalls: calls };
				messages.push(call_message);
				await persist(call_message);
			}
			if (calls.length === 0) {
				if (result.stopReason === 'refusal') throw new Error('AI provider refused the run');
				await updateRecord(
					ctx,
					'automation_run',
					runId,
					{
						status: 'success',
						output: { text: finalText },
						error: null,
						completed_at: new Date().toISOString()
					},
					{ isElevated: true }
				);
				return { runId, status: 'success', text: finalText, sessionId, inputMessageId };
			}
			for (const call of calls) {
				let output: Record<string, unknown>;
				try {
					output = await executeTool(options.spec, call);
				} catch (cause) {
					output = {
						error: cause instanceof Error ? cause.message : String(cause)
					};
				}
				const tool_message: AiMessage = {
					role: 'tool',
					content: JSON.stringify(output),
					toolCallId: call.id
				};
				messages.push(tool_message);
				await persist(tool_message);
			}
		}
		throw new Error(`Agent exceeded maxIterations (${maxIterations})`);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		await persist({ role: 'system', content: message }).catch(() => undefined);
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
