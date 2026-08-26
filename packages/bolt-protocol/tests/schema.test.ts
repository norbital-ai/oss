import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	AIRequest,
	FacilityName,
	Invocation,
	PROTOCOL_VERSION,
	TaskRequest,
	TransportRequest,
	TransportResponse
} from '../src/index.js';

describe('Bolt protocol schemas', () => {
	it('carries bounded provider-neutral web search and a response schema on AI turns', () => {
		const decoded = Schema.decodeUnknownSync(AIRequest)({
			_tag: 'Turn',
			model: 'provider/model',
			messages: [{ role: 'user', content: 'Check the current filing.' }],
			tools: [],
			maxOutputTokens: 1_024,
			webSearch: { maxResults: 5, allowedDomains: ['acra.gov.sg'] },
			responseSchema: {
				type: 'object',
				properties: { changed: { type: 'boolean' } },
				required: ['changed'],
				additionalProperties: false
			}
		});
		expect(decoded).toMatchObject({
			_tag: 'Turn',
			webSearch: { maxResults: 5, allowedDomains: ['acra.gov.sg'] },
			responseSchema: { type: 'object' }
		});
		for (const maxResults of [0, 26, 1.5]) {
			expect(
				Schema.decodeUnknownResult(AIRequest)({
					_tag: 'Turn',
					model: 'provider/model',
					messages: [],
					tools: [],
					maxOutputTokens: 1,
					webSearch: { maxResults }
				})._tag
			).toBe('Failure');
		}
		expect(
			Schema.decodeUnknownResult(AIRequest)({
				_tag: 'Turn',
				model: 'provider/model',
				messages: [],
				tools: [],
				maxOutputTokens: 1,
				webSearch: { maxResults: 5, allowedDomains: [''] }
			})._tag
		).toBe('Failure');
	});

	it('rejects an unsupported protocol version', () => {
		const decoded = Schema.decodeUnknownResult(Invocation)({
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION + 1,
			id: 'invoke-1',
			scope: { tenantId: 'tenant-1', environment: 'production', releaseId: 'release-1' },
			deadlineEpochMs: Date.now() + 1_000,
			command: 'health',
			input: null,
			headers: { authorization: ['Bearer fixture-token'] }
		});
		expect(decoded._tag).toBe('Failure');
	});

	it('includes transport in the standardized facility name set', () => {
		expect(Schema.decodeUnknownSync(FacilityName)('transport')).toBe('transport');
		expect(Schema.decodeUnknownResult(FacilityName)('sse')._tag).toBe('Failure');
	});

	it('carries exact task lifecycle signals on the current protocol version', () => {
		for (const tag of ['Active', 'Settled', 'Interrupt'] as const) {
			expect(Schema.decodeUnknownSync(TaskRequest)({ _tag: tag, taskId: 'agent-turn-1' })).toEqual({
				_tag: tag,
				taskId: 'agent-turn-1'
			});
		}
		// 4 is the version that stopped carrying asset bytes inside the artifact. The literal is
		// asserted rather than the constant compared to itself: a bump is a deliberate act, and a
		// release that changes shape without one is the failure this pins.
		expect(PROTOCOL_VERSION).toBe(4);
	});

	it('decodes transport requests without selecting a wire protocol', () => {
		const open = Schema.decodeUnknownSync(TransportRequest)({
			_tag: 'Open',
			topic: 'sync'
		});
		const send = Schema.decodeUnknownSync(TransportRequest)({
			_tag: 'Send',
			connectionId: 'conn-1',
			kind: 'text',
			bytes: new Uint8Array([123])
		});
		const pull = Schema.decodeUnknownSync(TransportRequest)({
			_tag: 'Pull',
			connectionId: 'conn-1',
			maxFrames: 16
		});
		const close = Schema.decodeUnknownSync(TransportRequest)({
			_tag: 'Close',
			connectionId: 'conn-1',
			reason: 'done'
		});
		expect(open).toMatchObject({ _tag: 'Open', topic: 'sync' });
		expect(send._tag).toBe('Send');
		expect(pull._tag).toBe('Pull');
		expect(close._tag).toBe('Close');
	});

	it('keeps transport responses JSON-safe and connection-scoped', () => {
		const decoded = Schema.decodeUnknownSync(TransportResponse)({
			connectionId: 'conn-1',
			frames: [
				{
					sequence: 0,
					kind: 'text',
					bytes: new Uint8Array([1]),
					cursor: '0'
				}
			],
			closed: false
		});
		expect(decoded.connectionId).toBe('conn-1');
		expect(decoded.frames?.[0]?.sequence).toBe(0);
	});
});
