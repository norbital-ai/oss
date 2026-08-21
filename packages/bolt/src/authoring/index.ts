export { automation, defineAutomation } from './automations-schema.js';
export type {
	AgentAutomationSpec,
	AutomationContext,
	AutomationDeclaration,
	AutomationDefinition,
	AutomationTrigger
} from './automations-schema.js';

export type {
	AfterHookApi,
	AnySchema,
	ApprovalRequestQuery,
	ApprovalRequestRow,
	BeforeApi,
	ChannelDefinition,
	CollectionHooks,
	CollectionIntegrations,
	CollectionPipelines,
	CollectionPullBinding,
	CollectionReceiveBinding,
	CollectionWebhookBinding,
	SendRequestSpec,
	PullCursorSpec,
	PullIdentitySpec,
	PullPagesSpec,
	PullRecordsSpec,
	PullRequestSpec,
	PullRetrySpec,
	WebhookRequestSpec,
	WebhookSignatureSpec,
	CollectionQuery,
	DefaultWorkspaceSchema,
	ElevatedMutationPayload,
	HookApi,
	InputValuesForTables,
	McpServerDefinition,
	NearestQueryConfig,
	MutationInsertFor,
	MutationUpdateFor,
	PolicyDefinition,
	SchemaFieldFilter,
	SchemaQueryConfig,
	SchemaQueryRow,
	SchemaRawOperators,
	SchemaRow,
	SchemaWhere,
	SystemRow,
	StructuredInferenceInput,
	TableName,
	TablesForModels,
	TableShape,
	Teams,
	WorkspaceAuthoringTypes
} from './contracts-schema.js';

export { defineAgentTool } from './agent-tools.js';
export type { AgentToolDefinition } from './agent-tools.js';
export { defineMcpServer } from './mcp.js';
export type { McpServerDeclaration } from './mcp.js';

export { defineCommandHandler, defineQueryHandler } from './handlers-schema.js';
export {
	defineEnvironment,
	describeEnvironment,
	type EnvironmentSpec,
	type EnvironmentVariableSpec,
	type EnvironmentVariableView
} from './environment-schema.js';
export type {
	DynamicCollectionApi,
	HandlerDefinition,
	TExportAction,
	TExportManifest,
	TFileAttachment
} from './handlers-schema.js';

export {
	cascade,
	clockTime,
	custom,
	date,
	dateRange,
	dateRangeSchema,
	defineCustomType,
	defineModel,
	enums,
	file,
	geolocation,
	group,
	hexToBinaryEmbedding,
	numeric,
	phone,
	refuse,
	text,
	timestamp,
	vector
} from './models-schema.js';
export { AuthoredRefusal } from './refusal.js';
export { defineRateLimits } from './rate-limits-schema.js';
export type { RateLimitKey, RateLimitRule, RateLimitSpec } from './rate-limits-schema.js';
export type {
	BoltGroupDefinition,
	CustomTypeDefinition,
	CustomTypeFactoryOptions,
	CustomTypeOptionsMap,
	CustomTypeOutput,
	CustomTypeResolvedSchema,
	CustomTypeValueMap,
	DateRange,
	FileRef,
	ModelDeclaration,
	ModelMetadata
} from './models-schema.js';

export {
	agent,
	app,
	channel,
	collection,
	defineConnection,
	defineEnvVars,
	definePull,
	defineSend,
	defineWebhook,
	environment,
	field,
	integration,
	policy,
	tool,
	workspace
} from './workspace-schema.js';
export type {
	AgentDeclaration,
	AppDeclaration,
	ChannelDeclaration,
	CollectionDefinition,
	EnvironmentDeclaration,
	EnvVarConfig,
	FieldDefinition,
	HttpConnection,
	IntegrationDeclaration,
	IntegrationPullDeclaration,
	IntegrationSendDeclaration,
	IntegrationSendEvent,
	IntegrationWebhookDeclaration,
	PolicyDeclaration,
	PrivateEnvReference,
	RelationDefinition,
	RelationEndpoint,
	RuntimePolicyGrant,
	ScalarType,
	ToolDeclaration,
	WorkspaceDefinition,
	WorkspaceDraft
} from './workspace-schema.js';

export { sql } from 'drizzle-orm';
export { boolean, integer, jsonb, uuid } from 'drizzle-orm/pg-core';
