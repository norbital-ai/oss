import type { AppendOnlyLogSpec } from '@norbital-ai/store';
import {
	AuditEvent,
	AUDIT_ACTOR_KINDS,
	AUDIT_CATEGORIES,
	AUDIT_STATUSES
} from '../protocol/audit.ts';

/** Bolt supplies its envelope; Store owns the native log programs and storage policy. */
export const auditLogSpec = (scoped: boolean): AppendOnlyLogSpec => ({
	format: 1,
	namespace: 'bolt_audit',
	scope: scoped ? ['platform', 'tenant', 'environment'] : [],
	retirement: scoped,
	retention: { days: 30, batch: 1000 },
	envelope: {
		id: ['id'],
		at: ['at'],
		payload: ['payload'],
		required: Object.keys(AuditEvent.fields),
		nonempty: [['operationId'], ['action']],
		objects: [['actor']],
		enums: [
			{ path: ['category'], values: AUDIT_CATEGORIES },
			{ path: ['status'], values: AUDIT_STATUSES },
			{ path: ['actor', 'kind'], values: AUDIT_ACTOR_KINDS }
		]
	},
	indexes: [
		{
			name: 'event_actor',
			paths: [
				['actor', 'kind'],
				['actor', 'id']
			]
		},
		{
			name: 'event_subject',
			paths: [
				['subject', 'model'],
				['subject', 'id']
			]
		},
		{ name: 'event_status', paths: [['status']] },
		{ name: 'event_category', paths: [['category']] },
		{ name: 'event_action', paths: [['action']] },
		{ name: 'event_invocation', paths: [['invocation']] },
		{ name: 'event_run', paths: [['run']] }
	],
	pending: {
		status: ['status'],
		operation: ['operationId'],
		prepared: 'prepared',
		unresolved: ['prepared', 'unknown'],
		terminalSuffix: ':terminal'
	}
});
