import { sha256_hex } from '@norbital-ai/store';
import type { AiRequest } from '../contracts.ts';

const encoder = new TextEncoder();
const part = (text: string) => ({
	sha256: sha256_hex(text),
	characters: text.length,
	bytes: encoder.encode(text).byteLength
});

/** Fingerprint the AI-port request; retain no prompt text, credentials or attachment bytes in logs. */
export function requestEvidence(request: AiRequest) {
	const files = request.files?.map(({ mime, bytes, call }) => ({
		mime,
		bytes: bytes.byteLength,
		sha256: sha256_hex(bytes),
		...(call === undefined ? {} : { call })
	}));
	return {
		format: 1,
		boundary: 'ai.port',
		sha256: sha256_hex(JSON.stringify({ ...request, ...(files === undefined ? {} : { files }) })),
		model: request.model,
		effort: request.effort ?? null,
		purpose: request.purpose ?? null,
		system: request.system === undefined ? null : part(request.system),
		messages: { ...part(JSON.stringify(request.messages)), count: request.messages.length },
		tools:
			request.tools === undefined
				? null
				: {
						...part(JSON.stringify(request.tools)),
						items: request.tools.map((tool) => ({
							name: tool.name,
							sha256: sha256_hex(JSON.stringify(tool))
						}))
					},
		files: files ?? null,
		output: request.output === undefined ? null : part(JSON.stringify(request.output)),
		continuation: request.continuation === undefined ? null : part(request.continuation)
	};
}

/** Preserve projected row order and gaps without repeating every message ID on every request. */
export function sequenceRanges(sequences: readonly number[]): number[][] {
	const ranges: number[][] = [];
	for (const sequence of sequences) {
		const last = ranges.at(-1);
		if (last !== undefined && last[1] === sequence - 1) last[1] = sequence;
		else ranges.push([sequence, sequence]);
	}
	return ranges;
}
