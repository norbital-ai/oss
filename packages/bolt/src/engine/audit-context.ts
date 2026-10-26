import { Context } from 'effect';
import type { AuditEvent } from '../protocol/audit.ts';
import type { DbBatch } from './db/tenant-db.ts';
import type { Sql } from './contracts.ts';

/** Private correlation only. Full request/response bodies belong exclusively to the host's audit store. */
export type AuditMutation = {
	readonly event: AuditEvent;
	readonly recordedAt: string;
	readonly outcomeKey?: string;
	readonly digest?: string;
	readonly run?: string;
	readonly approval?: string;
};
export const AuditMutation = Context.Reference<AuditMutation | undefined>('bolt/AuditMutation', {
	defaultValue: () => undefined
});
export const auditContextSql = (operation: AuditMutation): Sql => ({
	text: "SELECT set_config('bolt.audit',$1,true)",
	params: [operation.event.operationId]
});
export const auditReceiptSql = (operation: AuditMutation): Sql => ({
	text: "INSERT INTO bolt_audit_receipt(operation,at,outcome_key,digest,run,approval,expires_at) VALUES($1,$2::timestamptz,$3,$4,$5,$6::uuid,$7::timestamptz+interval '30 days') ON CONFLICT(operation) DO NOTHING",
	params: [
		operation.event.operationId,
		operation.event.at,
		operation.outcomeKey ?? null,
		operation.digest ?? null,
		operation.run ?? null,
		operation.approval ?? null,
		operation.recordedAt
	]
});
export const auditedBatch = (batch: DbBatch, operation: AuditMutation): DbBatch => ({
	...batch,
	statements: [auditContextSql(operation), ...batch.statements, auditReceiptSql(operation)]
});
