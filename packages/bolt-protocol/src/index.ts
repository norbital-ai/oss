import { HostCommandContracts } from './host.js';
import { SyncCommandContracts } from './sync.js';
import { SystemCommandContracts } from './system.js';

/** The one protocol-owned fixed command catalogue consumed by runtime and browser projections. */
export const FixedCommandCatalogue = [
	...HostCommandContracts,
	...SyncCommandContracts,
	...SystemCommandContracts
] as const;
export type FixedCommandContract = (typeof FixedCommandCatalogue)[number];
export type FixedCommandName = FixedCommandContract['name'];

export { WebPage, WebPageRequest, WEB_READ_OPERATION, WEB_PAGE_BYTE_LIMIT } from './web.js';

export {
	CollectionBaseRowVersion,
	CollectionGroup,
	CollectionGroupedQueryRequest,
	CollectionGroupedQueryRequestFields,
	CollectionMutationBaseVersion,
	CollectionMutationGraph,
	CollectionMutationPush,
	mutationGraphDeleteIds,
	CollectionMutationSettlement,
	COLLECTION_MUTATION_RETRY_HORIZON_MILLIS,
	COLLECTION_MUTATION_QUARANTINE_RETENTION_MILLIS,
	CollectionMutateRequest,
	CollectionMutationIdempotencyKey,
	CollectionAnchoredPage,
	CollectionQueryRequest,
	CollectionQueryRequestFields,
	CollectionLexicalSearch,
	CollectionSearch,
	CollectionSemanticSearch,
	CollectionWriteValues,
	StoredRecord
} from './collections.js';

export {
	ActivationResult,
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_BUNDLE_FILE,
	ARTIFACT_RELEASE_FILE,
	artifactCodeGraphRefusals,
	ArtifactCodeChunk,
	ArtifactCodeGraph,
	ArtifactCodeImport,
	ArtifactMigration,
	ArtifactMigrationLineage,
	ArtifactObjectReference,
	ArtifactProvenance,
	AssetIndexEntry,
	BundleManifest,
	BundleModuleError,
	BundleResult,
	canonicalArtifactCodeGraphIndexEncoding,
	canonicalTenantReleaseEncoding,
	COMPILED_MANIFEST_VERSION,
	decodeBoltBundleModule,
	DispatchResponse,
	ManifestIntegration,
	ManifestIntegrationBinding,
	ManifestDestination,
	ManifestOrigin,
	ManifestPullCursor,
	ManifestPullPages,
	ManifestSchemaPlan,
	ManifestSchemaStep,
	missingFacilities,
	RealtimeOutput,
	Registration,
	SyncSchemaFacts,
	TenantRelease,
	tenantReleaseObjects,
	WorkspaceAuthoringManifest
} from './bundle.js';
export type { BoltBundle } from './bundle.js';

export { CommandHeaders, type CommandContract, type CommandResponseContract } from './host.js';

export {
	HOST_RECOVER_COMMAND,
	HOST_SCHEDULE_DISCOVER_COMMAND,
	HOST_SCHEDULE_SETTLE_COMMAND,
	HostCommandContracts,
	HostRecoverRequest,
	HostRecoverResponse,
	HostScheduleDiscoverRequest,
	HostScheduleDiscoverResponse,
	HostScheduleOccurrence,
	HostScheduleOutcome,
	HostScheduleRejection,
	HostScheduleSettleRequest,
	HostScheduleSettleResponse
} from './host.js';

export {
	ChangeBatch,
	compactSyncChanges,
	LinkAndRouteValues,
	SyncAdvanceRequest,
	SyncAdvanceReset,
	SyncAdvanceResponse,
	SyncCommandContracts,
	SyncAdvanceSubscription,
	SyncAdvanceUpdate,
	SyncApplyFrame,
	SyncChange,
	SyncConnectRequest,
	SyncConnectEvaluation,
	SyncConnectEvaluationResult,
	SyncConnectResponse,
	SyncConnectResult,
	SyncExtendPrefixEvaluation,
	SyncExtendPrefixRequest,
	SyncExtendPrefixResponse,
	SyncOutcome,
	SyncPrefixDelta,
	SyncPrefixKey,
	SyncPrefixPut,
	SyncPrefixReset,
	SyncPrefixUpdate,
	SyncQueryKey,
	SyncQueryInput,
	SyncQueryVersion,
	SyncResetReason,
	SyncRoutingConstraint,
	SyncScope,
	SyncScopedApplyFrame,
	SyncSubEntry,
	SyncViewerPrefixDelta,
	SyncWriteStatus,
	syncApplyFrameByteLength,
	syncScopedApplyFrameByteLength,
	syncJsonByteLength,
	syncRetainedPrefixBytes,
	SYNC_CONNECTION_HEADER,
	DEFAULT_SYNC_LOADED_KEYS,
	MAX_SYNC_INITIAL_ANSWER_BYTES,
	MAX_SYNC_LOADED_KEYS,
	MAX_SYNC_OUTBOUND_FRAME_BYTES,
	MAX_SYNC_RETAINED_PREFIX_BYTES
} from './sync.js';
export {
	SyncConnectionLane,
	SyncRegistry,
	type SyncPrefixExtensionDecision,
	type SyncPrefixViewerState,
	type SyncRegistryConnection
} from './sync-registry.js';

export {
	AgentId,
	AIGenerationOutput,
	AIToolDefinition,
	AIGenerationResult,
	AIRequest,
	AIResponse,
	CommunicationRequest,
	CommunicationResponse,
	ChannelSendPayload,
	ConnectorRequest,
	ConnectorResponse,
	DatabaseRequest,
	DatabaseResponse,
	facilityCallFor,
	FileRequest,
	FileResponse,
	HostToolRequest,
	HostToolResponse,
	HostToolCatalog,
	IdentityHookRequest,
	IdentityHookResponse,
	TaskRequest,
	TaskResponse,
	SyncCommitRequest,
	SyncCommitResponse,
	TransportFrame,
	TransportFrameKind,
	TransportRequest,
	TransportResponse,
	ConfigRequest,
	ConfigResponse,
	DirectiveId,
	DirectiveMode,
	DirectivePriority,
	DirectiveState,
	ExactCharge,
	ImageAsset,
	MessageId,
	ModelCatalogEntry,
	ModelId,
	PlanId,
	PlanVerdict,
	PlanStatus,
	ProviderCallId,
	ProviderObservation,
	ProviderUsageEncoded,
	RunId,
	RunPhase,
	RunStatus,
	SubjectId,
	TaskAudience,
	TaskId,
	TaskStatus,
	UsageObservation,
	WorkbenchId
} from './facilities.js';
export type { FacilityBinding, FacilityBindings } from './facilities.js';

export { Activation, Invocation, InvocationScope, PluginTrustedContext } from './invocation.js';

export {
	ApprovalState,
	DataBrowserCommandContract,
	EnvoyStatus,
	SecretsStatus,
	SystemCommandContracts,
	TaskControlRequest,
	TaskControlResult,
	TaskEditMessageRequest,
	TaskEditMessageResult,
	TaskExecuteRequest,
	TaskExecuteResult,
	TaskModelCatalog,
	TaskSubmitRequest,
	TaskSubmitResult,
	WorkspaceAccess,
	WorkspaceAutomationContract,
	WorkspaceInvokeContract
} from './system.js';

export {
	EffectId,
	EnvironmentName,
	failure,
	CallSubject,
	FacilityCall,
	FacilityName,
	FacilityResult,
	InvocationId,
	makeWireError,
	PROTOCOL_VERSION,
	ProtocolVersion,
	ProviderOutcome,
	ReleaseId,
	success,
	TenantId,
	WireError,
	WireErrorOptions
} from './wire.js';

export {
	makeTimekeeperCore,
	MAX_TIMEKEEPER_TIMEOUT_MILLIS,
	type TimekeeperCompletion,
	type TimekeeperCore,
	type TimekeeperEntry,
	type TimekeeperHost,
	type TimekeeperResolution
} from './timekeeper-contract.js';

export {
	GATEWAY_SECRET_VARIABLE,
	SIGNATURE_LIFETIME_MILLIS,
	SYSTEM_SIGNATURE_HEADER,
	SYSTEM_TIMESTAMP_HEADER,
	systemSignaturePayload,
	type SystemSignaturePayload
} from './system-signature.js';
