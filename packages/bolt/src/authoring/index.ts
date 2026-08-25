export interface WorkspaceAuthoringTypes {}
export interface WorkspaceTeamAuthoringTypes {}

export { AutomationProgression, defineAutomation } from './automations-schema.js';
export type {
	AutomationApi,
	AutomationContext,
	AutomationDefinition,
	AutomationTrigger
} from './automations-schema.js';

export { defineAgentTool } from './agent-tools.js';

export { approveBy, noApproval } from './approval-flow.js';
export type { ApprovalFlow, ApprovalReviewFlow, NoApprovalFlow } from './approval-flow.js';

export type {
	AfterHookApi,
	AnySchema,
	AppName,
	BeforeApi,
	CollectionHooks,
	CollectionIntegrations,
	CollectionPipelines,
	EnvoyDefinition,
	HookApi,
	PolicyDecisionApi,
	PolicyDefinition,
	PolicyWriteContext,
	SchemaQueryConfig,
	SchemaQueryRow,
	TeamName,
	Teams
} from './contracts-schema.js';

export { defineCommandHandler, defineQueryHandler } from './handlers-schema.js';
export type { TExportManifest } from './handlers-schema.js';

export { defineEnvironment } from './environment-schema.js';

export {
	cascade,
	custom,
	defineCustomType,
	defineModel,
	enums,
	file,
	geolocation,
	group,
	hexToBinaryEmbedding,
	instant,
	instantRangeSchema,
	instantRangeValueSchema,
	moneySchema,
	moneyValueSchema,
	numeric,
	phone,
	platformCustomTypes,
	reference,
	refuse,
	text,
	vector
} from './models-schema.js';
export type {
	CustomTypeFactoryOptions,
	CustomTypeOutput,
	FileRef,
	InstantPrecision,
	InstantRangeNested,
	InstantRangeValue,
	ReferenceHandle,
	ReferenceTargets
} from './models-schema.js';

export {
	defineConnection,
	definePull,
	defineWebhook,
	McpServerDefinition,
	McpToolRoute,
	SkillDeclaration
} from './workspace-schema.js';

export { anonymousLimits } from './rate-limits-schema.js';

export { sql } from 'drizzle-orm/sql/sql';
export { boolean } from 'drizzle-orm/pg-core/columns/boolean';
export { bytea } from 'drizzle-orm/pg-core/columns/bytea';
export { integer } from 'drizzle-orm/pg-core/columns/integer';
export { jsonb } from 'drizzle-orm/pg-core/columns/jsonb';
export { uuid } from 'drizzle-orm/pg-core/columns/uuid';
