import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	AIRequest,
	AIResponse,
	FacilityName,
	ImageAsset,
	Invocation,
	PROTOCOL_VERSION,
	TaskRequest,
	TransportRequest,
	TransportResponse
} from '../src/index.js';

describe('Bolt protocol schemas', () => {
	it('carries a provider-neutral image asset without carrying its bytes', () => {
		const asset = Schema.decodeUnknownSync(ImageAsset)({
			key: 'evidence/large.jpg',
			name: 'large.jpg',
			mimeType: 'image/jpeg',
			size: 1_042_884,
			detail: 'low'
		});
		expect(asset.key).toBe('evidence/large.jpg');
		expect(JSON.stringify(asset)).not.toContain('base64');
	});

	it('carries only the canonical Effect model boundary and exact provider observation', () => {
		const decoded = Schema.decodeUnknownSync(AIRequest)({
			_tag: 'Generate',
			callId: 'call-1',
			modelId: 'provider/model',
			messages: [{ role: 'user', content: 'Check the current filing.' }],
			maxOutputTokens: 1_024,
			output: { _tag: 'Message' },
			imageAssets: [
				{ key: 'evidence/filing.pdf', name: 'filing.pdf', mimeType: 'application/pdf', size: 42 }
			]
		});
		expect(decoded).toMatchObject({
			_tag: 'Generate',
			callId: 'call-1',
			modelId: 'provider/model'
		});
		expect(Object.keys(AIRequest.cases.Generate.fields)).toEqual([
			'_tag',
			'callId',
			'modelId',
			'messages',
			'maxOutputTokens',
			'output',
			'imageAssets'
		]);
		const response = Schema.decodeUnknownSync(AIResponse)({
			_tag: 'Generated',
			result: {
				_tag: 'Message',
				message: { role: 'assistant', content: 'The filing changed.' }
			},
			observation: {
				callId: 'call-1',
				provider: 'fixture',
				model: 'provider/model',
				operation: 'language',
				charge: { currency: 'USD', coefficient: '125', scale: 6 },
				chargeSource: 'provider'
			}
		});
		expect(response._tag).toBe('Generated');
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
		// 8 is the clean Effect task/model and versioned-prefix Sync cut. The literal is
		// asserted rather than the constant compared to itself: a bump is a deliberate act, and a
		// release that changes shape without one is the failure this pins.
		expect(PROTOCOL_VERSION).toBe(8);
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
