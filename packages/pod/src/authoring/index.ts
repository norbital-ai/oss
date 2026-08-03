/** Filesystem-first tenant workspace authoring primitives. */

/** Compiler-generated tenant declarations merge exact filesystem-derived authoring names here. */
export interface WorkspaceAuthoringTypes {}

export { sql } from 'drizzle-orm';
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

/**
 * The elevated server API, for tenant code that must both read and write.
 *
 * Until now a workspace could have one or the other. An `after` hook receives
 * `AfterHookApi`, whose `db` is an `ElevatedMutationApi` — permission-bypassing
 * writes and **no `query`**. A remote command handler receives `BeforeApi` —
 * `query`, but ordinary permission-checked writes. Anything that has to read the
 * previous state *and* write a derived record could satisfy neither, and the
 * workarounds were both wrong in the same direction: a command handler writing
 * unelevated fails for any role whose policy grants read on the derived
 * collection but not create, and a hook reaching for `api.db.query` calls a
 * method that is not there.
 *
 * Elevation is deliberate and total: every read and write made through this API
 * bypasses policy. Reach for it only where the *workspace* is the author of the
 * record — a derived projection, a computed rollup, an audit row — never to
 * carry out something a user asked for on their own behalf, because at that
 * point their policy is the only thing deciding whether they may.
 *
 * Loaded on call rather than at module scope: the implementation reaches
 * `node:async_hooks` for its request-local store, and this module is imported by
 * workspace definitions that are also read in the browser.
 */
export async function getElevatedApi(): Promise<import('./workspace/hook-api.js').AfterApi> {
	const { getElevatedAfterApi } = await import('$lib/server/collection/hook-api-context.server.js');
	return getElevatedAfterApi();
}
