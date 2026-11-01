import { createHash } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import type { AiRequest } from '../src/engine/contracts.ts';
import { requestEvidence, sequenceRanges } from '../src/engine/agent/request.ts';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

it('fingerprints the complete port request while retaining only metadata', () => {
	const request: AiRequest = {
		model: 'default',
		purpose: 'chat',
		effort: 'medium',
		system: 'Private instructions 世界',
		messages: [{ role: 'user', content: 'Private message' }],
		tools: [{ name: 'read', description: 'Private description', input: { type: 'object' } }],
		output: { type: 'string' },
		files: [{ mime: 'image/png', bytes: new Uint8Array([0, 128, 255]), call: 'read-1' }],
		continuation: 'Private continuation'
	};
	const evidence = requestEvidence(request);
	expect(evidence.sha256).toBe(
		sha256(
			JSON.stringify({
				...request,
				files: [
					{
						mime: 'image/png',
						bytes: 3,
						sha256: sha256(new Uint8Array([0, 128, 255])),
						call: 'read-1'
					}
				]
			})
		)
	);
	expect(evidence.system).toEqual({
		sha256: sha256('Private instructions 世界'),
		characters: 'Private instructions 世界'.length,
		bytes: Buffer.byteLength('Private instructions 世界')
	});
	expect(evidence.tools?.items).toEqual([
		{ name: 'read', sha256: sha256(JSON.stringify(request.tools?.[0])) }
	]);
	expect(JSON.stringify(evidence)).not.toContain('Private');
	expect(JSON.stringify(evidence)).not.toContain('[0,128,255]');
	const changes: AiRequest[] = [
		{ ...request, model: 'other' },
		{ ...request, effort: 'low' },
		{ ...request, system: 'Changed' },
		{ ...request, messages: [{ role: 'user', content: 'Changed' }] },
		{ ...request, tools: [{ name: 'read', description: 'Changed', input: { type: 'object' } }] },
		{
			...request,
			tools: [{ name: 'read', description: 'Private description', input: { type: 'string' } }]
		},
		{
			...request,
			files: [{ mime: 'image/png', bytes: new Uint8Array([0, 128, 254]), call: 'read-1' }]
		},
		{ ...request, output: { type: 'number' } },
		{ ...request, continuation: 'Changed' }
	];
	expect(
		new Set([evidence.sha256, ...changes.map((change) => requestEvidence(change).sha256)]).size
	).toBe(changes.length + 1);
});

it('preserves source sequence gaps and order in compact projection references', () => {
	expect(sequenceRanges([])).toEqual([]);
	expect(sequenceRanges([2, 3, 4, 8, 9, 1])).toEqual([
		[2, 4],
		[8, 9],
		[1, 1]
	]);
});
