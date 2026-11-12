import { Context } from 'effect';
import type { AuditEvent } from '../protocol/audit.ts';
import type { Json } from '../decl/values.ts';
import type { DbBatch } from './db/tenant-db.ts';
import type { Sql } from './contracts.ts';

/** A row change a commit statement kept history for, as the terminal event carries it. */
export type AuditedRow = {
	readonly model: string;
	readonly id: string;
	readonly revision: number;
	readonly op: string;
	readonly cause: string;
	readonly old: Json;
	readonly new: Json;
};
/** What a commit statement answered for its own operation: no read follows it. */
export type AuditCommitted = {
	readonly outcome: Json;
	readonly at: string;
	readonly actor: string;
	readonly committedAt: string;
	readonly records: readonly AuditedRow[];
	/** An erasure's history purge waits for its own acknowledgement, so it is not deferred to the next statement. */
	readonly erase: boolean;
};

/** Private correlation only. Full request/response bodies belong exclusively to the host's audit store. */
export type AuditMutation = {
	readonly event: AuditEvent;
	readonly recorded_at: string;
	readonly outcomeKey?: string;
	readonly digest?: string;
	readonly run?: string;
	readonly approval?: string;
	/** Earlier operations whose terminal events are appended: the next commit statement acknowledges them. */
	readonly acknowledge?: readonly string[];
	/** Set by the commit statement that carried this operation's receipt. */
	readonly committed: { value?: AuditCommitted };
};
export const AuditMutation = Context.Reference<AuditMutation | undefined>('bolt/AuditMutation', {
	defaultValue: () => undefined
});
export const auditContextSql = (operation: AuditMutation): Sql => ({
	text: "SELECT set_config('bolt.audit',$1,true)",
	params: [operation.event.operation_id]
});
/** The receipt insert, its values placed by `p` by role (a commit statement shares its key, digest and operation). */
export const auditReceipt = (operation: AuditMutation, p: (role: string, value: Json) => string): string =>
	`INSERT INTO bolt_audit_receipt(operation,at,outcome_key,digest,run,approval,expires_at) VALUES(${p('operation', operation.event.operation_id)},${p('audit_at', operation.event.at)}::timestamptz,${p('key', operation.outcomeKey ?? null)},${p('digest', operation.digest ?? null)},${p('run', operation.run ?? null)},${p('approval', operation.approval ?? null)}::uuid,${p('recorded_at', operation.recorded_at)}::timestamptz+interval '30 days') ON CONFLICT(operation) DO NOTHING`;
export const auditReceiptSql = (operation: AuditMutation): Sql => {
	const params: Json[] = [];
	const text = auditReceipt(operation, (_role, value) => `$${params.push(value)}`);
	return { text, params };
};
export const auditedBatch = (batch: DbBatch, operation: AuditMutation): DbBatch => ({
	...batch,
	statements: [auditContextSql(operation), ...batch.statements, auditReceiptSql(operation)]
});
