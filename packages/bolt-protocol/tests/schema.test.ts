import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	FacilityName,
	Invocation,
	PROTOCOL_VERSION,
	TaskRequest,
	TransportRequest,
	TransportResponse
} from '../src/index.js';

describe('Bolt protocol schemas', () => {
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

	/**
	 * Register only describes durable routing now. Older senders may still include the unused lease
	 * marker, and Effect's struct decoder deliberately strips that surplus field. Keeping this
	 * compatibility is why deleting it does not require a protocol-version refusal.
	 */
	it('strips the retired task registration lease without changing the wire version', () => {
		const decoded = Schema.decodeUnknownSync(TaskRequest)({
			_tag: 'Register',
			leaseId: 'legacy-lease',
			releaseId: 'release-1',
			command: 'tasks.tick'
		});
		expect(decoded).toEqual({
			_tag: 'Register',
			releaseId: 'release-1',
			command: 'tasks.tick'
		});
		expect(PROTOCOL_VERSION).toBe(2);
	});

	it('decodes one-way SSE and two-way WebSocket transport requests', () => {
		const open = Schema.decodeUnknownSync(TransportRequest)({
			_tag: 'Open',
			protocol: 'sse',
			direction: 'one-way',
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
		expect(open).toMatchObject({ _tag: 'Open', protocol: 'sse', direction: 'one-way' });
		expect(send._tag).toBe('Send');
		expect(pull._tag).toBe('Pull');
		expect(close._tag).toBe('Close');
		expect(
			Schema.decodeUnknownResult(TransportRequest)({
				_tag: 'Open',
				protocol: 'http',
				direction: 'one-way'
			})._tag
		).toBe('Failure');
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
