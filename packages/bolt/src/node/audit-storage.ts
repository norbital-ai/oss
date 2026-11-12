// Store's format:1 envelope is a disk format, independent of the public host ABI's field names.
import { Schema } from 'effect';
import { AuditEvent, AuditSummary, type AuditRecord, type AuditPreparedRecord } from '../protocol/audit.ts';

const { id, operation_id, at, ...event } = AuditEvent.fields;
export const StoredAuditEvent = Schema.Struct({ id, operationId: operation_id, at, ...event });
const { payload, ...metadata } = StoredAuditEvent.fields;
export const StoredAuditSummary = Schema.Struct({
	...metadata,
	recordedAt: AuditSummary.fields.recorded_at,
	payloadBytes: AuditSummary.fields.payload_bytes
});
export const StoredAuditRecord = Schema.Struct({ ...StoredAuditSummary.fields, payload });
export const StoredAuditPreparedRecord = Schema.Struct({ ...StoredAuditRecord.fields, status: Schema.Literal('prepared') });

export const storedAuditEvent = (value: AuditEvent): typeof StoredAuditEvent.Type => {
	const { id, operation_id, at, ...event } = value;
	return { id, operationId: operation_id, at, ...event };
};
export const auditSummary = (value: typeof StoredAuditSummary.Type): AuditSummary => {
	const { operationId, recordedAt, payloadBytes, ...metadata } = value;
	return { ...metadata, operation_id: operationId, recorded_at: recordedAt, payload_bytes: payloadBytes };
};
export const auditRecord = (value: typeof StoredAuditRecord.Type): AuditRecord => {
	const { payload, ...summary } = value;
	return { ...auditSummary(summary), payload };
};
export const auditPreparedRecord = (value: typeof StoredAuditPreparedRecord.Type): AuditPreparedRecord => ({
	...auditRecord(value), status: 'prepared'
});
