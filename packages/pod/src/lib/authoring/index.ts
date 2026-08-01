/** Filesystem-first tenant workspace authoring primitives. */

/** Compiler-generated tenant declarations merge exact filesystem-derived authoring names here. */
export interface WorkspaceAuthoringTypes {}

export { boolean, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export {
	date,
	enums,
	custom,
	dateRange,
	file,
	geolocation,
	numeric,
	phone,
	clockTime,
	timestamp
} from './builtin/columns.js';
export type { CustomTypeOptionsMap, CustomTypeValueMap } from './builtin/columns.js';
export { defineCustomType } from './custom-type.js';
export type {
	AnyCustomTypeDefinition,
	CustomTypeDefinition,
	CustomTypeFactoryOptions,
	CustomTypeOutput,
	CustomTypeResolvedSchema
} from './custom-type.js';

export {
	dateRangeZodSchema,
	fileZodSchema,
	geolocationZodSchema,
	moneyZodSchema
} from './builtin/custom_types.js';

export { ISO_CURRENCY } from './builtin/money.js';

export { cascade, defineModel, group } from './filesystem.js';
export { refuse } from './refuse.js';
export type { GroupDefinition, ModelDeclaration, ModelMetadata } from './filesystem.js';
export type {
	TableExclusion,
	TableExclusionElement,
	TableIndex,
	TableIndexMethod
} from './schema/table.js';
export type {
	CollectionHooks,
	CollectionIntegrations,
	CollectionPipelines
} from './schema/collection-behavior.js';
export type {
	AnySchema,
	DefaultWorkspaceSchema,
	SchemaQueryConfig,
	SchemaQueryRow,
	SchemaRow,
	TableName
} from './schema/types.js';
export { extract } from './schema/extract.js';
export {
	defineAutomation,
	type AgentAutomationSpec,
	type AutomationContext,
	type AutomationTrigger
} from './automations/automations.js';
export { defineAgentTool, type AgentToolDefinition } from './automations/agent-tools.js';
export { defineChannel } from './channels/channels.js';
export type { ChannelDefinition } from './channels/channels.js';
export { definePolicy } from './policies/policies.js';
export type {
	PolicyAction,
	PolicyApproval,
	PolicyApprovalStep,
	PolicyDefinition,
	PolicyGrant
} from './policies/policies.js';
export { defineCommandHandler, defineQueryHandler } from './automations/handlers.js';
export type { TExportAction, TExportManifest, TFileAttachment } from './automations/pipelines.js';
export { defineConnection } from './integrations/integrations.js';
export type {
	CollectionIntegrationDefinition,
	CollectionMutationEvent,
	CollectionReceiveBinding,
	CollectionSendBinding,
	HttpConnection,
	IntegrationRequest,
	PrivateEnvReference,
	PullTrigger,
	WebhookTrigger
} from './integrations/integrations.js';
export { defineEnv } from './env.js';
export type { WorkspaceEnvDeclaration } from './env.js';
export type { AfterApi, AfterHookApi, BeforeApi, HookApi } from './workspace/hook-api.js';
