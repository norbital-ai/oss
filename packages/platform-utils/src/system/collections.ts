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
	readonly policy_id: string | null;
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
	readonly chat_session: SystemRecordFields & {
		readonly user_id: string;
		readonly automation_run_id: string | null;
		readonly title: string;
		readonly platform: string | null;
		readonly visibility: string;
		readonly external_thread_id: string | null;
		readonly agent_profile_id: string | null;
		readonly channel_config_id: string | null;
		readonly assigned_channel_id: string | null;
	};
	readonly chat_turn: SystemRecordFields & {
		readonly chat_id: string;
		readonly prompt_message_id: string | null;
		readonly status: string;
		readonly model: string;
		readonly parent_turn_id: string | null;
		readonly subagent_id: string | null;
		readonly error: string | null;
		readonly started_at: string;
		readonly heartbeat_at: string;
		readonly ended_at: string | null;
	};
	readonly chat_message: SystemRecordFields & {
		readonly chat_id: string;
		readonly turn_id: string | null;
		readonly role: string;
		readonly seq: number;
		readonly parts: readonly unknown[] | null;
		readonly model: string | null;
		readonly usage: JsonObject | null;
		readonly plan_mode: boolean;
		readonly kind: string;
		readonly status: string;
		readonly queue_status: string;
		readonly release_mode: string | null;
		readonly author_user_id: string | null;
		readonly author_display_name: string | null;
		readonly source_provider: string | null;
		readonly source_conversation_id: string | null;
		readonly source_message_id: string | null;
		readonly source_deleted_at: string | null;
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
	readonly channel_conversation: SystemRecordFields & {
		readonly channel_key: string;
		readonly transport: string;
		readonly external_conversation_id: string;
		readonly binding_key: string;
		readonly chat_id: string;
		readonly last_inbound_at: string | null;
		readonly last_outbound_at: string | null;
	};
	readonly channel_inbound_message: SystemRecordFields & {
		readonly channel_key: string;
		readonly conversation_id: string;
		readonly external_conversation_id: string;
		readonly external_message_id: string;
		readonly receipt_key: string;
		readonly sender_external_id: string | null;
		readonly sender_display_name: string | null;
		readonly status: string;
		readonly error: string | null;
		readonly chat_message_id: string | null;
		readonly answered_at: string | null;
	};
	readonly integration_cursor: SystemRecordFields & {
		readonly integration_name: string;
		readonly binding_name: string;
		readonly binding_key: string;
		readonly cursor: string | null;
		readonly last_pulled_at: string | null;
		readonly last_error: string | null;
	};
	readonly integration_inbound_event: SystemRecordFields & {
		readonly integration_name: string;
		readonly binding_name: string;
		readonly binding_key: string;
		readonly event_id: string;
		readonly receipt_key: string;
		readonly status: string;
		readonly imported: number | null;
		readonly error: string | null;
		readonly completed_at: string | null;
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
	'chat_session',
	'chat_turn',
	'chat_message',
	'channel_conversation',
	'channel_inbound_message',
	'user',
	'team',
	'policy',
	'audit_event',
	'integration_outbox',
	'integration_cursor',
	'integration_inbound_event',
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
	chat_session: {
		name: 'chat_session',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'user_id', kind: 'uuid', nullable: false },
			{ name: 'automation_run_id', kind: 'uuid', nullable: true },
			{ name: 'title', kind: 'text', nullable: false },
			{ name: 'platform', kind: 'text', nullable: true },
			{ name: 'visibility', kind: 'text', nullable: false },
			{ name: 'external_thread_id', kind: 'text', nullable: true },
			{ name: 'agent_profile_id', kind: 'uuid', nullable: true },
			{ name: 'channel_config_id', kind: 'uuid', nullable: true },
			{ name: 'assigned_channel_id', kind: 'uuid', nullable: true }
		]
	},
	chat_turn: {
		name: 'chat_turn',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'chat_id', kind: 'uuid', nullable: false },
			{ name: 'prompt_message_id', kind: 'uuid', nullable: true },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'model', kind: 'text', nullable: false },
			{ name: 'parent_turn_id', kind: 'uuid', nullable: true },
			{ name: 'subagent_id', kind: 'text', nullable: true },
			{ name: 'error', kind: 'text', nullable: true },
			{ name: 'started_at', kind: 'timestamptz', nullable: false },
			{ name: 'heartbeat_at', kind: 'timestamptz', nullable: false },
			{ name: 'ended_at', kind: 'timestamptz', nullable: true }
		]
	},
	chat_message: {
		name: 'chat_message',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'chat_id', kind: 'uuid', nullable: false },
			{ name: 'turn_id', kind: 'uuid', nullable: true },
			{ name: 'role', kind: 'text', nullable: false },
			{ name: 'seq', kind: 'integer', nullable: false },
			{ name: 'parts', kind: 'json', nullable: true },
			{ name: 'model', kind: 'text', nullable: true },
			{ name: 'usage', kind: 'json', nullable: true },
			{ name: 'plan_mode', kind: 'boolean', nullable: false },
			{ name: 'kind', kind: 'text', nullable: false },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'queue_status', kind: 'text', nullable: false },
			{ name: 'release_mode', kind: 'text', nullable: true },
			{ name: 'author_user_id', kind: 'uuid', nullable: true },
			{ name: 'author_display_name', kind: 'text', nullable: true },
			{ name: 'source_provider', kind: 'text', nullable: true },
			{ name: 'source_conversation_id', kind: 'text', nullable: true },
			{ name: 'source_message_id', kind: 'text', nullable: true },
			{ name: 'source_deleted_at', kind: 'timestamptz', nullable: true }
		]
	},
	channel_conversation: {
		name: 'channel_conversation',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'channel_key', kind: 'text', nullable: false },
			{ name: 'transport', kind: 'text', nullable: false },
			{ name: 'external_conversation_id', kind: 'text', nullable: false },
			{ name: 'binding_key', kind: 'text', nullable: false },
			{ name: 'chat_id', kind: 'uuid', nullable: false },
			{ name: 'last_inbound_at', kind: 'timestamptz', nullable: true },
			{ name: 'last_outbound_at', kind: 'timestamptz', nullable: true }
		]
	},
	channel_inbound_message: {
		name: 'channel_inbound_message',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'channel_key', kind: 'text', nullable: false },
			{ name: 'conversation_id', kind: 'uuid', nullable: false },
			{ name: 'external_conversation_id', kind: 'text', nullable: false },
			{ name: 'external_message_id', kind: 'text', nullable: false },
			{ name: 'receipt_key', kind: 'text', nullable: false },
			{ name: 'sender_external_id', kind: 'text', nullable: true },
			{ name: 'sender_display_name', kind: 'text', nullable: true },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'error', kind: 'text', nullable: true },
			{ name: 'chat_message_id', kind: 'uuid', nullable: true },
			{ name: 'answered_at', kind: 'timestamptz', nullable: true }
		]
	},
	integration_cursor: {
		name: 'integration_cursor',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'integration_name', kind: 'text', nullable: false },
			{ name: 'binding_name', kind: 'text', nullable: false },
			{ name: 'binding_key', kind: 'text', nullable: false },
			{ name: 'cursor', kind: 'text', nullable: true },
			{ name: 'last_pulled_at', kind: 'timestamptz', nullable: true },
			{ name: 'last_error', kind: 'text', nullable: true }
		]
	},
	integration_inbound_event: {
		name: 'integration_inbound_event',
		fields: [
			...SYSTEM_FIELDS,
			{ name: 'integration_name', kind: 'text', nullable: false },
			{ name: 'binding_name', kind: 'text', nullable: false },
			{ name: 'binding_key', kind: 'text', nullable: false },
			{ name: 'event_id', kind: 'text', nullable: false },
			{ name: 'receipt_key', kind: 'text', nullable: false },
			{ name: 'status', kind: 'text', nullable: false },
			{ name: 'imported', kind: 'integer', nullable: true },
			{ name: 'error', kind: 'text', nullable: true },
			{ name: 'completed_at', kind: 'timestamptz', nullable: true }
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
			{ name: 'policy_id', kind: 'uuid', nullable: true }
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
