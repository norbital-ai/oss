import { z } from 'zod';
import { SystemRecordFieldsSchema } from './columns.js';

const JsonRecordSchema = z.record(z.string(), z.unknown());
const NullableProviderMetadataSchema = JsonRecordSchema.nullable().optional();

export const UserRoleSchema = z.enum(['admin', 'member']);
export type TUserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(['active', 'inactive', 'pending_invitation']);
export type TUserStatus = z.infer<typeof UserStatusSchema>;

export const ApprovalRequestStatusSchema = z.enum([
	'ONGOING',
	'APPROVED',
	'REJECTED',
	'REQUEST_FOR_CHANGE'
]);
export type TApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

export const ApprovalRequestStepStatusSchema = z.enum([
	'PENDING',
	'APPROVED',
	'REJECTED',
	'REQUEST_FOR_CHANGE'
]);
export type TApprovalRequestStepStatus = z.infer<typeof ApprovalRequestStepStatusSchema>;

export const ApprovalRequestStepActionSchema = z.enum([
	'APPROVED',
	'REJECTED',
	'REQUEST_FOR_CHANGE'
]);
export type TApprovalRequestStepAction = z.infer<typeof ApprovalRequestStepActionSchema>;

export const ApprovalLockedRecordLockTypeSchema = z.enum(['record_delete', 'record_mutation']);
export type TApprovalLockedRecordLockType = z.infer<typeof ApprovalLockedRecordLockTypeSchema>;

export const ChatMessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type TChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

export const ChatMessagePartStateSchema = z.enum([
	'streaming',
	'done',
	'input-streaming',
	'input-available',
	'approval-requested',
	'approval-responded',
	'output-available',
	'output-error',
	'output-denied'
]);
export type TChatMessagePartState = z.infer<typeof ChatMessagePartStateSchema>;

export const MutationActionKeySchema = z.enum(['create', 'read', 'update', 'delete']);
export type TMutationActionKey = z.infer<typeof MutationActionKeySchema>;

const ChannelSchema = z
	.object({
		type: z.enum(['email', 'phone', 'wechat', 'telegram', 'whatsapp', 'slack']),
		verified: z.boolean().default(false),
		primary: z.boolean().default(false)
	})
	.catchall(z.unknown());

export const UserSchema = SystemRecordFieldsSchema.extend({
	email: z.string(),
	name: z.string().nullable(),
	avatar_url: z.string().nullable(),
	status: UserStatusSchema.nullable(),
	role: UserRoleSchema.nullable(),
	kind: z.string().nullable(),
	channels: z.array(ChannelSchema).nullable()
});
export type TUser = z.infer<typeof UserSchema>;

export const TeamSchema = SystemRecordFieldsSchema.extend({
	name: z.string(),
	description: z.string().nullable(),
	parent_id: z.string().nullable(),
	is_active: z.boolean(),
	kind: z.string().nullable(),
	policy_id: z.string()
});
export type TTeam = z.infer<typeof TeamSchema>;

export const ApprovalConfigStepNodeSchema = z.object({
	id: z.string(),
	name: z.string(),
	teams_that_can_approve: z.array(z.string()),
	description: z.string().nullable(),
	conditions: JsonRecordSchema,
	get nextSteps(): z.ZodArray<typeof ApprovalConfigStepNodeSchema> {
		return z.array(ApprovalConfigStepNodeSchema);
	}
});
export type TApprovalConfigStepNode = z.infer<typeof ApprovalConfigStepNodeSchema>;

export const ApprovalConfigSchema = z.object({
	norbital_id: z.string(),
	approval_name: z.string(),
	supercede_teams: z.array(z.string()),
	conditions: JsonRecordSchema,
	approval_step_nodes: z.array(ApprovalConfigStepNodeSchema)
});
export type TApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

export const PolicyReadGrantSchema = z.object({
	id: z.string(),
	collection_name: z.string(),
	action: z.literal('read'),
	conditions: JsonRecordSchema
});
export type TPolicyReadGrant = z.infer<typeof PolicyReadGrantSchema>;

export const PolicyMutationGrantSchema = z.object({
	id: z.string(),
	collection_name: z.string(),
	action: z.enum(['create', 'update', 'delete']),
	conditions: JsonRecordSchema,
	// Stored as loose JSON in tenant DBs: rows written before approval_config
	// existed (and seeds that omit it) must keep parsing — absent means "no
	// approval required", same as null (see collection_permission.guard).
	approval_config: ApprovalConfigSchema.nullable().default(null)
});
export type TPolicyMutationGrant = z.infer<typeof PolicyMutationGrantSchema>;

export const PolicyGrantSchema = z.discriminatedUnion('action', [
	PolicyReadGrantSchema,
	PolicyMutationGrantSchema
]);
export type TPolicyGrant = z.infer<typeof PolicyGrantSchema>;

export const PolicySchema = SystemRecordFieldsSchema.extend({
	key: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	is_active: z.boolean(),
	accessible_applications: z.array(z.string()).nullable(),
	grants: z.array(PolicyGrantSchema)
});
export type TPolicy = z.infer<typeof PolicySchema>;

export const ApprovalRequestStepActionHistorySchema = z.object({
	action: ApprovalRequestStepActionSchema,
	comments: z.string().nullable(),
	actionBy: z.string(),
	actionOn: z.string()
});
export type TApprovalRequestStepActionHistory = z.infer<
	typeof ApprovalRequestStepActionHistorySchema
>;

export const ApprovalRequestStepNodeSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	teams_that_can_approve: z.array(z.string()),
	status: ApprovalRequestStepStatusSchema,
	history: z.array(ApprovalRequestStepActionHistorySchema)
});
export type TApprovalRequestStepNode = z.infer<typeof ApprovalRequestStepNodeSchema>;

export const ApprovalRequestLockedRecordRefSchema = z.object({
	collection_name: z.string(),
	record_id: z.string(),
	lock_type: ApprovalLockedRecordLockTypeSchema
});
export type TApprovalRequestLockedRecordRef = z.infer<typeof ApprovalRequestLockedRecordRefSchema>;

export const ApprovalRequestSchema = SystemRecordFieldsSchema.extend({
	label: z.string(),
	approval_config_id: z.string(),
	collection_name: z.string(),
	status: ApprovalRequestStatusSchema,
	approval_step_nodes: z.array(z.array(ApprovalRequestStepNodeSchema)),
	locked_record_refs: z.array(ApprovalRequestLockedRecordRefSchema),
	closed_at: z.string().nullable(),
	organization_id: z.string()
}).catchall(z.unknown());
export type TApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const AutomationRunStatusSchema = z.enum(['running', 'success', 'failed']);
export type TAutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunTriggerSchema = z.enum(['MANUAL', 'CRON', 'AGENT']);
export type TAutomationRunTrigger = z.infer<typeof AutomationRunTriggerSchema>;

export const AutomationRunSchema = SystemRecordFieldsSchema.extend({
	automation_name: z.string(),
	status: z.string(),
	input: JsonRecordSchema.nullable(),
	output: JsonRecordSchema.nullable(),
	error: z.string().nullable(),
	started_at: z.string().nullable(),
	completed_at: z.string().nullable()
});
export type TAutomationRun = z.infer<typeof AutomationRunSchema>;

export const DateRangeSchema = z.object({
	start: z.string(),
	end: z.string()
});
export type TDateRange = z.infer<typeof DateRangeSchema>;

export const ChatMessageTextPartSchema = z.object({
	type: z.literal('text'),
	text: z.string(),
	state: ChatMessagePartStateSchema.nullable().optional(),
	providerMetadata: NullableProviderMetadataSchema
});
export type TChatMessageTextPart = z.infer<typeof ChatMessageTextPartSchema>;

export const ChatMessageReasoningPartSchema = z.object({
	type: z.literal('reasoning'),
	text: z.string(),
	state: ChatMessagePartStateSchema.nullable().optional(),
	providerMetadata: NullableProviderMetadataSchema
});
export type TChatMessageReasoningPart = z.infer<typeof ChatMessageReasoningPartSchema>;

export const ChatMessageSourceUrlPartSchema = z.object({
	type: z.literal('source-url'),
	sourceId: z.string(),
	url: z.string(),
	title: z.string().nullable().optional(),
	providerMetadata: NullableProviderMetadataSchema
});
export type TChatMessageSourceUrlPart = z.infer<typeof ChatMessageSourceUrlPartSchema>;

export const ChatMessageSourceDocumentPartSchema = z.object({
	type: z.literal('source-document'),
	sourceId: z.string(),
	mediaType: z.string(),
	title: z.string(),
	filename: z.string().nullable().optional(),
	providerMetadata: NullableProviderMetadataSchema
});
export type TChatMessageSourceDocumentPart = z.infer<typeof ChatMessageSourceDocumentPartSchema>;

export const ChatMessageFilePartSchema = z.object({
	type: z.literal('file'),
	mediaType: z.string(),
	filename: z.string().nullable().optional(),
	url: z.string(),
	providerMetadata: NullableProviderMetadataSchema
});
export type TChatMessageFilePart = z.infer<typeof ChatMessageFilePartSchema>;

export const ChatMessageStepStartPartSchema = z.object({
	type: z.literal('step-start')
});
export type TChatMessageStepStartPart = z.infer<typeof ChatMessageStepStartPartSchema>;

export const ChatMessageDataPartSchema = z.object({
	type: z.string(),
	id: z.string().nullable().optional(),
	data: z.unknown().optional()
});
export type TChatMessageDataPart = z.infer<typeof ChatMessageDataPartSchema>;

export const ChatMessageToolApprovalSchema = z.object({
	id: z.string(),
	approved: z.boolean().nullable().optional(),
	reason: z.string().nullable().optional()
});
export type TChatMessageToolApproval = z.infer<typeof ChatMessageToolApprovalSchema>;

export const ChatMessageToolCallPartSchema = z.object({
	type: z.string(),
	state: ChatMessagePartStateSchema,
	toolCallId: z.string(),
	toolName: z.string().nullable().optional(),
	title: z.string().nullable().optional(),
	toolMetadata: NullableProviderMetadataSchema,
	providerExecuted: z.boolean().nullable().optional(),
	input: z.unknown().optional(),
	rawInput: z.unknown().optional(),
	output: z.unknown().optional(),
	errorText: z.string().nullable().optional(),
	callProviderMetadata: NullableProviderMetadataSchema,
	resultProviderMetadata: NullableProviderMetadataSchema,
	preliminary: z.boolean().nullable().optional(),
	approval: ChatMessageToolApprovalSchema.nullable().optional()
});
export type TChatMessageToolCallPart = z.infer<typeof ChatMessageToolCallPartSchema>;

export const ChatMessagePartSchema = z.union([
	ChatMessageTextPartSchema,
	ChatMessageReasoningPartSchema,
	ChatMessageSourceUrlPartSchema,
	ChatMessageSourceDocumentPartSchema,
	ChatMessageFilePartSchema,
	ChatMessageStepStartPartSchema,
	ChatMessageDataPartSchema,
	ChatMessageToolCallPartSchema
]);
export type TChatMessagePart = z.infer<typeof ChatMessagePartSchema>;

export const ChatMessageSchema = z.object({
	id: z.string(),
	role: ChatMessageRoleSchema,
	metadata: z.unknown().optional(),
	parts: z.array(ChatMessagePartSchema)
});
export type TChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatSessionSchema = SystemRecordFieldsSchema.extend({
	title: z.string(),
	user_id: z.string(),
	platform: z.string().nullable(),
	external_thread_id: z.string().nullable(),
	messages: z.array(ChatMessageSchema)
});
export type TChatSession = z.infer<typeof ChatSessionSchema>;

export const GeolocationSchema = z.object({
	geometry: z.object({ lon: z.number(), lat: z.number() }).nullable(),
	formatted_address: z.string(),
	type: z.literal('Point'),
	srid: z.number()
});
export type TGeolocation = z.infer<typeof GeolocationSchema>;

export const MoneySchema = z.object({
	value: z.number(),
	currency: z.string()
});
export type TMoney = z.infer<typeof MoneySchema>;
