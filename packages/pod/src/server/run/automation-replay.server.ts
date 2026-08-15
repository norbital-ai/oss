import { AiChatResultSchema, type AiChatResult } from '@norbital-ai/platform-utils/runtime/binding';
import type { DurableHostEffectRequest } from '$lib/host/types.js';
import { createHash } from 'node:crypto';
import { createAsyncStore } from '$lib/server/async-store.js';
import { z } from 'zod';

export const DurableAutomationEffectSchema = z.object({
	ordinal: z.number().int().nonnegative(),
	requestHash: z.string(),
	status: z.enum(['succeeded', 'failed']),
	result: AiChatResultSchema.optional(),
	error: z.string().optional()
});
export type DurableAutomationEffect = z.infer<typeof DurableAutomationEffectSchema>;

export type AutomationReplayContext = {
	readonly jobId: string;
	readonly effects: readonly DurableAutomationEffect[];
	nextOrdinal: number;
	pending?: AutomationEffectYield;
};

export const automationReplayStorage = createAsyncStore<AutomationReplayContext>();

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value != null && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

export function automationEffectRequestHash(request: DurableHostEffectRequest): string {
	return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

export class AutomationEffectYield extends Error {
	readonly effectId: string;
	readonly ordinal: number;
	readonly requestHash: string;
	readonly request: DurableHostEffectRequest;

	constructor(input: {
		jobId: string;
		ordinal: number;
		requestHash: string;
		request: DurableHostEffectRequest;
	}) {
		super('Automation is waiting for a durable AI effect.');
		this.name = 'AutomationEffectYield';
		this.effectId = `${input.jobId}:${input.ordinal}:${input.requestHash.slice(0, 24)}`;
		this.ordinal = input.ordinal;
		this.requestHash = input.requestHash;
		this.request = input.request;
	}
}

export function isAutomationEffectYield(value: unknown): value is AutomationEffectYield {
	return value instanceof AutomationEffectYield;
}

export function pendingAutomationEffect(): AutomationEffectYield | undefined {
	return automationReplayStorage.getStore()?.pending;
}

function decodeResult(result: AiChatResult, schema?: z.ZodType): unknown {
	if (!schema) return result.text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.text);
	} catch {
		throw new Error('AI provider returned invalid JSON for a structured response');
	}
	return schema.parse(parsed);
}

/**
 * Resolve one authored `api.infer()` call by deterministic replay.
 *
 * The ordinal is the call's position in the handler, not a random id. Re-running the handler after
 * a crash therefore finds the same completed effect. A changed request at the same ordinal is
 * refused rather than returning a result produced for different input.
 */
export function replayAutomationAi(input: {
	readonly request: DurableHostEffectRequest;
	readonly schema?: z.ZodType;
}): unknown {
	const replay = automationReplayStorage.getStore();
	if (!replay) return undefined;
	const ordinal = replay.nextOrdinal++;
	const requestHash = automationEffectRequestHash(input.request);
	const completed = replay.effects.find((effect) => effect.ordinal === ordinal);
	if (completed) {
		if (completed.requestHash !== requestHash) {
			const detail =
				input.request.kind === 'ai.turn'
					? `kind=ai.turn messages=${input.request.messages.length} tools=${(input.request.tools ?? []).map((tool) => tool.name).join(',')}`
					: `kind=${input.request.kind}`;
			throw new Error(
				`Automation AI request changed at durable step ${ordinal}; deploy a new run instead of replaying incompatible work. (${detail})`
			);
		}
		if (completed.status === 'failed') {
			throw new Error(completed.error ?? 'AI provider failed without an error message');
		}
		if (!completed.result) throw new Error(`Automation AI step ${ordinal} has no stored result.`);
		switch (input.request.kind) {
			case 'ai.turn':
				return completed.result;
			case 'ai.prompt':
				return decodeResult(completed.result, input.schema);
			default: {
				const _exhaustive: never = input.request;
				throw new Error(`Unhandled durable AI effect kind: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}

	const pending = new AutomationEffectYield({
		jobId: replay.jobId,
		ordinal,
		requestHash,
		request: input.request
	});
	replay.pending = pending;
	throw pending;
}
