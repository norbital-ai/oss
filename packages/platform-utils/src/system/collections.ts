import type {
	CollectionDefinition,
	CollectionRecord,
	CollectionType
} from '../collection/types.js';
import type { SystemRecordFields } from './columns.js';

type JsonObject = Record<string, unknown>;

export interface PlatformUserRow extends SystemRecordFields {
	readonly email: string;
	readonly name: string | null;
	readonly avatar_url: string | null;
	readonly status: string | null;
	readonly role: string | null;
	readonly kind: string | null;
	readonly channels: unknown[] | null;
}

export interface PlatformUserCreateInput {
	readonly email: string;
	readonly name?: string | null;
	readonly avatar_url?: string | null;
	readonly status?: string | null;
	readonly role?: string | null;
	readonly kind?: string | null;
	readonly channels?: unknown[] | null;
}

export interface PlatformUserUpdateInput {
	readonly email?: string;
	readonly name?: string | null;
	readonly avatar_url?: string | null;
	readonly status?: string | null;
	readonly role?: string | null;
	readonly kind?: string | null;
	readonly channels?: unknown[] | null;
}

interface PlatformTeamRow extends SystemRecordFields {
	readonly name: string;
	readonly description: string | null;
	readonly parent_id: string | null;
	readonly is_active: boolean;
	readonly kind: string | null;
	readonly policy_id: string;
}

interface PlatformPolicyRow extends SystemRecordFields {
	readonly key: string;
	readonly name: string;
	readonly description: string | null;
	readonly is_active: boolean;
	readonly accessible_applications: string[] | null;
	readonly grants: unknown[] | null;
}

interface PlatformApprovalRequestRow extends SystemRecordFields {
	readonly organization_id: string;
	readonly label: string;
	readonly approval_config_id: string;
	readonly collection_name: string;
	readonly status: string;
	readonly approval_step_nodes: unknown[];
	readonly locked_record_refs: unknown[];
	readonly closed_at: string | null;
}

interface PlatformAutomationRunRow extends SystemRecordFields {
	readonly requested_by_user_id: string;
	readonly automation_name: string | null;
	readonly status: string;
	readonly input: JsonObject | null;
	readonly output: JsonObject | null;
	readonly error: string | null;
	readonly started_at: string | null;
	readonly completed_at: string | null;
}

interface PlatformAuditRow extends SystemRecordFields {
	readonly collection_name: string | null;
	readonly record_id: string | null;
	readonly actor_id: string | null;
}

interface PlatformSystemRows {
	readonly approval_request: PlatformApprovalRequestRow;
	readonly requestor: SystemRecordFields & {
		readonly approval_request_id: string;
		readonly user_id: string;
	};
	readonly automation_run: PlatformAutomationRunRow;
	readonly agent_run_step: SystemRecordFields & {
		readonly owner_user_id: string;
		readonly automation_run_id: string;
		readonly sequence: number;
		readonly kind: string;
		readonly role: string | null;
		readonly content: string | null;
		readonly tool_call_id: string | null;
		readonly tool_name: string | null;
		readonly tool_input: JsonObject | null;
		readonly tool_output: JsonObject | null;
		readonly usage: JsonObject | null;
	};
	readonly invitation: SystemRecordFields & {
		readonly email: string;
		readonly token_hash: string;
		readonly role: string;
		readonly invited_by_user_id: string | null;
		readonly expires_at: string;
		readonly consumed_at: string | null;
		readonly consumed_user_id: string | null;
	};
	readonly host_event_outbox: SystemRecordFields & {
		readonly event: string;
		readonly reason: string;
		readonly subject_hmac: string | null;
		readonly seats: JsonObject | null;
		readonly observed_at: string;
		readonly status: string;
		readonly attempts: number;
		readonly available_at: string;
		readonly claimed_at: string | null;
		readonly delivered_at: string | null;
		readonly last_error: string | null;
	};
	readonly user: PlatformUserRow;
	readonly team: PlatformTeamRow;
	readonly policy: PlatformPolicyRow;
	readonly audit_event: PlatformAuditRow & {
		readonly event_type: string;
		readonly details: JsonObject | null;
	};
	readonly integration_outbox: SystemRecordFields & {
		readonly integration_name: string;
		readonly binding_name: string;
		readonly collection_name: string;
		readonly record_id: string;
		readonly action: string;
		readonly payload: JsonObject;
		readonly status: string;
		readonly attempts: number;
		readonly available_at: string;
		readonly claimed_at: string | null;
		readonly delivered_at: string | null;
		readonly last_error: string | null;
	};
	readonly notification_outbox: SystemRecordFields & {
		readonly channel: string;
		readonly recipient_user_id: string;
		readonly subject: string;
		readonly message: string;
		readonly cta_label: string | null;
		readonly cta_url: string | null;
		readonly status: string;
		readonly attempts: number;
		readonly available_at: string;
		readonly claimed_at: string | null;
		readonly delivered_at: string | null;
		readonly last_error: string | null;
	};
	readonly notification: SystemRecordFields & {
		readonly recipient_user_id: string;
		readonly subject: string;
		readonly message: string;
		readonly channels: string[] | null;
		readonly cta_label: string | null;
		readonly cta_url: string | null;
		readonly notification_category: string | null;
		readonly read_at: string | null;
	};
	readonly document_asset: SystemRecordFields & {
		readonly owner_user_id: string;
		readonly file_name: string;
		readonly mime_type: string | null;
		readonly file_size: number | null;
		readonly storage_key: string;
	};
	readonly team_members: SystemRecordFields & {
		readonly user_id: string;
		readonly team_id: string;
	};
}

export const SYSTEM_COLLECTION_NAMES = [
	'approval_request',
	'requestor',
	'invitation',
	'host_event_outbox',
	'automation_run',
	'agent_run_step',
	'user',
	'team',
	'policy',
	'audit_event',
	'integration_outbox',
	'notification_outbox',
	'notification',
	'document_asset',
	'team_members'
] as const;

export type SystemCollectionName = (typeof SYSTEM_COLLECTION_NAMES)[number];

export type PlatformCollections = {
	readonly [TName in SystemCollectionName]: TName extends 'user'
		? CollectionType<PlatformUserRow, PlatformUserCreateInput, PlatformUserUpdateInput>
		: CollectionType<PlatformSystemRows[TName], CollectionRecord, CollectionRecord>;
};

const SYSTEM_FIELDS = [
	{ name: 'norbital_id', kind: 'uuid', nullable: false, readOnly: true },
	{ name: 'norbital_created_at', kind: 'timestamptz', nullable: false, readOnly: true },
	{ name: 'norbital_updated_at', kind: 'timestamptz', nullable: false, readOnly: true },
	{ name: 'norbital_sys_period', kind: 'tstzrange', nullable: false, readOnly: true },
	{ name: 'norbital_row_version', kind: 'integer', nullable: false, readOnly: true },
	{ name: 'norbital_approval_id', kind: 'uuid', nullable: true, readOnly: true }
] as const;

export const SYSTEM_COLLECTION_DEFINITIONS = {
	approval_request: {
		name: 'approval_request',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'organization_id', kind: 'uuid', nullable: false },
			{ name: 'label', kind: 'text', nullable: false },
			{ name: 'approval_config_id', kind: 'uuid', nullable: false },
			{ name: 'collection_name', kind: 'text', nullable: false },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'approval_step_nodes', kind: 'json', nullable: false, array: true },
			{ name: 'locked_record_refs', kind: 'json', nullable: false, array: true },
			{ name: 'closed_at', kind: 'timestamptz', nullable: true }
		]
	},
	requestor: {
		name: 'requestor',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'approval_request_id', kind: 'uuid', nullable: false },
			{ name: 'user_id', kind: 'uuid', nullable: false }
		]
	},
	automation_run: {
		name: 'automation_run',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'requested_by_user_id', kind: 'uuid', nullable: false },
			{ name: 'automation_name', kind: 'text', nullable: true },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'input', kind: 'json', nullable: true },
			{ name: 'output', kind: 'json', nullable: true },
			{ name: 'error', kind: 'text', nullable: true },
			{ name: 'started_at', kind: 'timestamptz', nullable: true },
			{ name: 'completed_at', kind: 'timestamptz', nullable: true }
		]
	},
	agent_run_step: {
		name: 'agent_run_step',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'owner_user_id', kind: 'uuid', nullable: false },
			{ name: 'automation_run_id', kind: 'uuid', nullable: false },
			{ name: 'sequence', kind: 'integer', nullable: false },
			{ name: 'kind', kind: 'text', nullable: false },
			{ name: 'role', kind: 'text', nullable: true },
			{ name: 'content', kind: 'text', nullable: true },
			{ name: 'tool_call_id', kind: 'text', nullable: true },
			{ name: 'tool_name', kind: 'text', nullable: true },
			{ name: 'tool_input', kind: 'json', nullable: true },
			{ name: 'tool_output', kind: 'json', nullable: true },
			{ name: 'usage', kind: 'json', nullable: true }
		]
	},
	invitation: {
		name: 'invitation',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'email', kind: 'text', nullable: false, label: 'Email' },
			{ name: 'token_hash', kind: 'text', nullable: false },
			{ name: 'role', kind: 'text', nullable: false },
			{ name: 'invited_by_user_id', kind: 'uuid', nullable: true },
			{ name: 'expires_at', kind: 'timestamptz', nullable: false },
			{ name: 'consumed_at', kind: 'timestamptz', nullable: true },
			{ name: 'consumed_user_id', kind: 'uuid', nullable: true }
		]
	},
	host_event_outbox: {
		name: 'host_event_outbox',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'event', kind: 'text', nullable: false },
			{ name: 'reason', kind: 'text', nullable: false },
			{ name: 'subject_hmac', kind: 'text', nullable: true },
			{ name: 'seats', kind: 'json', nullable: true },
			{ name: 'observed_at', kind: 'timestamptz', nullable: false },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'attempts', kind: 'integer', nullable: false },
			{ name: 'available_at', kind: 'timestamptz', nullable: false },
			{ name: 'claimed_at', kind: 'timestamptz', nullable: true },
			{ name: 'delivered_at', kind: 'timestamptz', nullable: true },
			{ name: 'last_error', kind: 'text', nullable: true }
		]
	},
	user: {
		name: 'user',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'email', kind: 'text', nullable: false, label: 'Email' },
			{ name: 'name', kind: 'text', nullable: true, label: 'Name' },
			{ name: 'avatar_url', kind: 'text', nullable: true, label: 'Avatar' },
			{ name: 'status', kind: 'text', nullable: true, label: 'Status' },
			{ name: 'role', kind: 'text', nullable: true, label: 'Role' },
			{ name: 'kind', kind: 'text', nullable: true, label: 'Kind' },
			{ name: 'channels', kind: 'json', nullable: true, array: true, label: 'Channels' }
		]
	},
	team: {
		name: 'team',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'name', kind: 'text', nullable: false },
			{ name: 'description', kind: 'text', nullable: true },
			{ name: 'parent_id', kind: 'text', nullable: true },
			{ name: 'is_active', kind: 'boolean', nullable: false },
			{ name: 'kind', kind: 'text', nullable: true },
			{ name: 'policy_id', kind: 'uuid', nullable: false }
		]
	},
	policy: {
		name: 'policy',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'key', kind: 'text', nullable: false },
			{ name: 'name', kind: 'text', nullable: false },
			{ name: 'description', kind: 'text', nullable: true },
			{ name: 'is_active', kind: 'boolean', nullable: false },
			{ name: 'accessible_applications', kind: 'json', nullable: true, array: true },
			{ name: 'grants', kind: 'json', nullable: true, array: true }
		]
	},
	audit_event: {
		name: 'audit_event',
		recordLabel: 'event_type',
		system: true,
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'event_type', kind: 'text', nullable: false },
			{ name: 'collection_name', kind: 'text', nullable: true },
			{ name: 'record_id', kind: 'uuid', nullable: true },
			{ name: 'details', kind: 'json', nullable: true },
			{ name: 'actor_id', kind: 'uuid', nullable: true }
		]
	},
	integration_outbox: {
		name: 'integration_outbox',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'integration_name', kind: 'text', nullable: false },
			{ name: 'binding_name', kind: 'text', nullable: false },
			{ name: 'collection_name', kind: 'text', nullable: false },
			{ name: 'record_id', kind: 'uuid', nullable: false },
			{ name: 'action', kind: 'text', nullable: false },
			{ name: 'payload', kind: 'json', nullable: false },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'attempts', kind: 'integer', nullable: false },
			{ name: 'available_at', kind: 'timestamptz', nullable: false },
			{ name: 'claimed_at', kind: 'timestamptz', nullable: true },
			{ name: 'delivered_at', kind: 'timestamptz', nullable: true },
			{ name: 'last_error', kind: 'text', nullable: true }
		]
	},
	notification_outbox: {
		name: 'notification_outbox',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'channel', kind: 'text', nullable: false },
			{ name: 'recipient_user_id', kind: 'uuid', nullable: false },
			{ name: 'subject', kind: 'text', nullable: false },
			{ name: 'message', kind: 'text', nullable: false },
			{ name: 'cta_label', kind: 'text', nullable: true },
			{ name: 'cta_url', kind: 'text', nullable: true },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'attempts', kind: 'integer', nullable: false },
			{ name: 'available_at', kind: 'timestamptz', nullable: false },
			{ name: 'claimed_at', kind: 'timestamptz', nullable: true },
			{ name: 'delivered_at', kind: 'timestamptz', nullable: true },
			{ name: 'last_error', kind: 'text', nullable: true }
		]
	},
	notification: {
		name: 'notification',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'recipient_user_id', kind: 'uuid', nullable: false },
			{ name: 'subject', kind: 'text', nullable: false },
			{ name: 'message', kind: 'text', nullable: false },
			{ name: 'channels', kind: 'json', nullable: true, array: true },
			{ name: 'cta_label', kind: 'text', nullable: true },
			{ name: 'cta_url', kind: 'text', nullable: true },
			{ name: 'notification_category', kind: 'text', nullable: true },
			{ name: 'read_at', kind: 'timestamptz', nullable: true }
		]
	},
	document_asset: {
		name: 'document_asset',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'owner_user_id', kind: 'uuid', nullable: false },
			{ name: 'file_name', kind: 'text', nullable: false },
			{ name: 'mime_type', kind: 'text', nullable: true },
			{ name: 'file_size', kind: 'integer', nullable: true },
			{ name: 'storage_key', kind: 'text', nullable: false }
		]
	},
	team_members: {
		name: 'team_members',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'user_id', kind: 'uuid', nullable: false },
			{ name: 'team_id', kind: 'uuid', nullable: false }
		]
	}
} satisfies {
	readonly [TName in SystemCollectionName]: CollectionDefinition<PlatformCollections[TName]>;
};
