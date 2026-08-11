/** Filesystem-first tenant workspace authoring primitives. */

/** Compiler-generated tenant declarations merge exact filesystem-derived authoring names here. */
export interface WorkspaceAuthoringTypes {}

export { sql } from 'drizzle-orm';
export { boolean, index, integer, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export {
	date,
	enums,
	custom,
	dateRange,
	file,
	geolocation,
	hexToBinaryEmbedding,
	numeric,
	phone,
	clockTime,
	text,
	timestamp,
	vector
} from './builtin/columns.js';
export type {
	CustomTypeOptionsMap,
	CustomTypeValueMap,
	EmbeddingColumnOptions,
	TextSearchableOptions
} from './builtin/columns.js';
export { defineCustomType } from './custom-type.js';
export type {
	AnyCustomTypeDefinition,
	CustomTypeDefinition,
	CustomTypeFactoryOptions,
	CustomTypeOutput,
	CustomTypeResolvedSchema
} from './custom-type.js';

export { dateRangeZodSchema, fileZodSchema, geolocationZodSchema } from './builtin/custom_types.js';
export { moneyZodSchema } from './builtin/money.js';

export { ISO_CURRENCY } from '@norbital-ai/std/finance';

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
	CollectionPipelines,
	DescribedHook
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
