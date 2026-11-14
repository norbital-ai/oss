// The audit store's format:1 disk envelope behind the public audit shapes.
import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import type { AuditEvent } from '@norbital-ai/host-api';
import { auditRecord, storedAuditEvent, StoredAuditRecord } from '../src/audit/storage.ts';

const event: AuditEvent = {
	id: 'act-1/accounts/account-1/2/committed',
	operation_id: 'act-1',
	at: '2026-10-25T00:00:00.000Z',
	category: 'write',
	action: 'accounts.update',
	status: 'committed',
	actor: { kind: 'member', id: 'member-1', label: 'Avery' },
	subject: { model: 'accounts', id: 'account-1', revision: 2 },
	invocation: 'act-1',
	transaction: null,
	run: null,
	approval: null,
	payload: { before: { balance: '20.00' }, after: { balance: '15.00' } }
};
it('preserves format:1 disk metadata and opaque payload keys behind the public audit adapter', () => {
	const payload = { operationId: 'provider-owned', recordedAt: 'verbatim', payloadBytes: 'µΩ' };
	const publicEvent = { ...event, payload };
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
	const nativeEvent = storedAuditEvent(publicEvent);
	expect(nativeEvent).toEqual({
		id: event.id,
		operationId: 'act-1',
		at: event.at,
		category: 'write',
		action: 'accounts.update',
		status: 'committed',
		actor: event.actor,
		subject: event.subject,
		invocation: 'act-1',
		transaction: null,
		run: null,
		approval: null,
		payload
	});
	expect(nativeEvent).not.toHaveProperty('operation_id');
	const historical = Schema.decodeUnknownSync(StoredAuditRecord)({
		...nativeEvent,
		recordedAt: '2026-10-25T00:00:01.000Z',
		payloadBytes
	});
	expect(auditRecord(historical)).toEqual({ ...publicEvent, recorded_at: '2026-10-25T00:00:01.000Z', payload_bytes: payloadBytes });
	expect(auditRecord(historical)).not.toHaveProperty('recordedAt');
	expect(auditRecord(historical).payload).toEqual(payload);
});
