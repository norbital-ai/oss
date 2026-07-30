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

type StepKind = 'message' | 'tool_call' | 'tool_result' | 'error';

type AgentRunOptions = {
	readonly automationName: string | null;
	readonly spec: AgentAutomationSpec;
	readonly input?: string;
	readonly runId?: string;
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

async function loadMessages(runId: string): Promise<{ messages: AiMessage[]; sequence: number }> {
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<{
		sequence: number;
		kind: StepKind;
		role: 'user' | 'assistant' | null;
		content: string | null;
		tool_call_id: string | null;
		tool_name: string | null;
		tool_input: Record<string, unknown> | null;
		tool_output: Record<string, unknown> | null;
	}>({
		text: `SELECT sequence, kind, role, content, tool_call_id, tool_name, tool_input, tool_output
		         FROM agent_run_step
		        WHERE automation_run_id = $1::uuid
		        ORDER BY sequence`,
		values: [runId]
	});
	const messages: AiMessage[] = [];
	let sequence = 0;
	for (const step of result.rows) {
		sequence = Math.max(sequence, step.sequence);
		if (step.kind === 'message' && step.content != null && step.role != null) {
			messages.push({ role: step.role, content: step.content });
		} else if (step.kind === 'tool_result') {
			messages.push({
				role: 'tool',
				content: JSON.stringify(step.tool_output ?? {}),
				...(step.tool_call_id ? { toolCallId: step.tool_call_id } : {})
			});
		} else if (
			step.kind === 'tool_call' &&
			step.tool_call_id &&
			step.tool_name &&
			step.tool_input
		) {
			messages.push({
				role: 'assistant',
				content: '',
				toolCalls: [
					{
						id: step.tool_call_id,
						name: step.tool_name,
						input: step.tool_input
					}
				]
			});
		}
	}
	return { messages, sequence };
}

export async function runAgent(options: AgentRunOptions): Promise<{
	readonly runId: string;
	readonly status: 'success';
	readonly text: string;
}> {
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
	const restored = await loadMessages(runId);
	let sequence = restored.sequence;
	const messages: AiMessage[] = [...restored.messages];
	const persist = async (kind: StepKind, values: Record<string, unknown>): Promise<void> => {
		sequence += 1;
		await createRecord(
			ctx,
			'agent_run_step',
			{ owner_user_id: ownerUserId, automation_run_id: runId, sequence, kind, ...values },
			{ isElevated: true }
		);
	};
	const initial = options.input ?? (messages.length === 0 ? options.spec.task : undefined);
	if (initial) {
		messages.push({ role: 'user', content: initial });
		await persist('message', { role: 'user', content: initial });
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
				await persist('message', {
					role: 'assistant',
					content: result.text,
					...(result.usage ? { usage: objectValue(result.usage) } : {})
				});
			}
			const calls = result.toolCalls ?? [];
			if (calls.length > 0) {
				messages.push({ role: 'assistant', content: '', toolCalls: calls });
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
				return { runId, status: 'success', text: finalText };
			}
			for (const call of calls) {
				await persist('tool_call', {
					tool_call_id: call.id,
					tool_name: call.name,
					tool_input: objectValue(call.input)
				});
				let output: Record<string, unknown>;
				try {
					output = await executeTool(options.spec, call);
				} catch (cause) {
					output = {
						error: cause instanceof Error ? cause.message : String(cause)
					};
				}
				await persist('tool_result', {
					tool_call_id: call.id,
					tool_name: call.name,
					tool_output: output
				});
				messages.push({
					role: 'tool',
					content: JSON.stringify(output),
					toolCallId: call.id
				});
			}
		}
		throw new Error(`Agent exceeded maxIterations (${maxIterations})`);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		await persist('error', { content: message }).catch(() => undefined);
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
}): Promise<{ readonly runId: string; readonly status: 'success'; readonly text: string }> {
	return runAgent({
		automationName: null,
		runId: input.runId,
		input: input.message,
		spec: { kind: 'agent', task: input.message }
	});
}
