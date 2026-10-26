import type { Effect } from 'effect';
import type {
	AuditEvent,
	AuditPage,
	AuditPendingPage,
	AuditPort,
	AuditQuery,
	AuditRecord,
	AuditSummary
} from '../../src/protocol/audit.ts';
import type { ShellApi } from '../../src/shell/api-types.ts';
import { automation } from '../../src/index.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

is<Eq<Effect.Success<ReturnType<ShellApi['audit']>>, AuditPage>>();
is<Eq<Effect.Success<ReturnType<ShellApi['auditDetail']>>, AuditRecord | null>>();
is<Eq<Awaited<ReturnType<AuditPort['query']>>, AuditPage>>();
is<Eq<Awaited<ReturnType<AuditPort['detail']>>, AuditRecord | null>>();
is<Eq<Awaited<ReturnType<AuditPort['pending']>>, AuditPendingPage>>();
is<Eq<AuditPort['mode'], 'durable' | 'buffered' | 'disabled'>>();
is<Eq<Parameters<AuditPort['append']>[0], readonly AuditEvent[]>>();

declare const summary: AuditSummary;
// @ts-expect-error list summaries do not claim to carry the full payload
void summary.payload;
const historical: AuditQuery = { model: 'removed_model_name', record: 'historical-id' };
void historical;
// @ts-expect-error the host binds tenant scope, not the caller's query
const tenant: AuditQuery = { tenant: 'another-tenant' };
// @ts-expect-error the host binds environment scope, not the caller's query
const environment: AuditQuery = { environment: 'another-environment' };
// @ts-expect-error audit order names time direction, never raw SQL or a payload expression
const order: AuditQuery = { order: 'payload->balance desc' };
// @ts-expect-error a lifecycle filter cannot pretend an unconfirmed database result is successful
const status: AuditQuery = { status: 'assumedCommitted' };
void tenant;
void environment;
void order;
void status;

automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* (_, ctx) {
		// @ts-expect-error tenant code cannot append native administrative audit facts
		void ctx.audit;
	}
});
