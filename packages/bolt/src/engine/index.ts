// One flat, Effect-native engine surface. Hosts activate EngineLive and own the runtime edge.
// ── exports: db ──
export * from './contracts.ts';
export * from '../protocol/audit.ts';
export { Audit, auditFromAbi, auditShape, type AuditShape } from './audit.ts';
export * from './errors.ts';
export { BoltError, CODE, CODES, PHASES, type Code, type Phase } from '../protocol/errors.ts';
export * from './services.ts';
export * from './ports.ts';
export { Port, type PortFailure } from './port.ts';
export * from './host.ts';
export { Secrets, type SecretsCodec, type SecretsShape } from './secrets.ts';
export {
	TenantDb,
	type DbBatch,
	type DbSession,
	type TenantDbShape,
	type RawDb
} from './db/tenant-db.ts';
export * from './manifest.ts';
export type { Json } from '../decl/values.ts';
// ── exports: query ──
export {
	ReadsLive,
	readEngine,
	memoReads,
	coalescing,
	readComposed,
	lowerRead
} from './query/engine.ts';
export { historyAt } from '../protocol/reads.ts';
export { readHistory, pruneHistory } from './query/history.ts';
// ── exports: guest ──
export { GuestConfig, GuestLive, type GuestOptions, type GuestProgram } from './guest/runner.ts';
export { TelemetryLive } from './guest/telemetry.ts';
// ── exports: writes ──
export { WritesLive, act, recordCapabilities, mayUpdate, type WriteEngine } from './write/act.ts';
export { minter, fingerprinting, Chain } from './write/sql.ts';
export {
	decodeSeed,
	restoreSource,
	seed,
	type RestoreSource,
	type SeedPack
} from './write/seed.ts';
export {
	loadPack,
	readPack,
	readPackSource,
	memorySource,
	sourceOf,
	type Pack,
	type PackJson,
	type PackSource
} from './write/pack.ts';
// ── exports: callables ──
export { CallablesLive, parseCallable, VERBS, admitVisitor, forActor } from './callables/index.ts';
export { upload, sizeBytes } from './callables/upload.ts';
export {
	ApprovalsLive,
	approvalHook,
	type ApprovalView,
	type DecideInput,
	type Decision
} from './approvals/approvals.ts';
export {
	DecisionsLive,
	DecisionRequestSchema,
	DecisionAnswerSchema,
	DecisionResultSchema,
	decisionsSystem1,
	encodeFiles,
	refusalOf,
	structuredSystem1,
	type DecisionAnswer,
	type DecisionsApiConfig,
	type DecisionFile,
	type DecisionQuestion,
	type DecisionRequest,
	type DecisionResult,
	type DecisionState,
	type System1,
	type System1Port,
	type System1Request
} from './decisions/index.ts';
// ── exports: identity ──
export { Authorities, previewAs } from './identity/actor.ts';
export {
	compileAuthority,
	writableColumns,
	visitorMayRead,
	operandValue
} from './access/authority.ts';
export { RateWindows, chargesFor, clientAddress } from './access/rate.ts';
export {
	IdentityLive,
	makeIdentityHost,
	founderBootstrap,
	loadKeys,
	loggedPhone,
	mint,
	signupOf,
	type IdentityHost,
	type PhoneVerifier,
	type Session,
	type Signup,
	type TransactionalProvider
} from './identity/session.ts';
export { assignTeam, membershipRun } from './identity/members.ts'; // Source-team affiliation; hosts bind membershipRun as runs.platform['bolt.membership'].
export { MEMBERSHIP } from './identity/session.ts';
export { applyPlan, plan, readApplied } from './schema/plan.ts'; // hook:hosting — Appendix D values (rule 69 activation)
export {
	applyMigrations,
	migrationSchema,
	readMigrations,
	statusMigrations,
	type MigrationBundle
} from './schema/migrations.ts';
export { MigrationImpact, impactLines, impactText } from '../protocol/migration-impact.ts';
export { catalogOf } from './access/pred.ts';
// ── exports: live ──
export { LiveHubLive, LIVE, INBOX_LIMIT, noticeRow } from './live/hub.ts';
// ── exports: commit ──
export {
	committed,
	compileCommit,
	compileOutcomeRecord,
	CommitAnswer,
	historyPiece,
	actorId,
	actorRef,
	type Commit,
	type Write,
	type OwnedLock,
	type RateCharge
} from './write/commit.ts';
export {
	enqueue,
	nextDue,
	queueEffects,
	triggersOf,
	type Triggers,
	type WebhookTrigger,
	type Writer
} from './runs/queue.ts';
export { duration, offsetMs, dueAt, backoffMs, BUCKET_MS, iso } from './runs/time.ts';
// ── exports: runs ──
export {
	DeadlineTimer,
	DeadlinesLive,
	inProcessDeadlines,
	type DeadlineEntry,
	type DeadlineCompletion,
	type DeadlineResolution
} from './runs/deadlines.ts';
export {
	RunsLive,
	RunHandlersLive,
	WakeLive,
	Nudges,
	RUN_VIEW_COLUMNS,
	RunViewRow,
	runView,
	type RunView
} from './runs/index.ts';
export { NOTICE_PUSH, noticePush, subscribe } from './runs/push.ts';
export { imageFacts, imageJpeg } from './files/image.ts';
export { DOWNLOAD, mediaType } from './files/media.ts';
// ── exports: links ──
export {
	HOOKS,
	integrationLinks,
	LinksLive,
	OAUTH_CALLBACK,
	webhookUrl,
	type LinkManager,
	type LinkAdmission,
	type LinksHost
} from './integrations/links.ts'; // hook:hosting — every host's instance links (§4.5)
export type {
	DriverOpen,
	Link,
	OAuthClient,
	OAuthVendor,
	Provider
} from './integrations/driver.ts'; // the one contract every provider implements
export { oauthClientOf } from './integrations/driver.ts';
export { credentials, type Credentials, type InstanceRow } from './integrations/credentials.ts'; // hook:hosting — a host's credential port
// ── exports: facilities and syncs ──
export {
	FacilitiesLive,
	facilityDispatch,
	fileLoader,
	loggedTransport,
	type FacilityPorts
} from './facilities.ts';
export { Syncs, SyncsLive, SyncHealth } from './sync/index.ts';
export { OutboundLive, sendInputSchema } from './integrations/outbound.ts';
export { documentConverter, type DocumentConverterConfig } from './convert.ts'; // the open-source ConvertPort (Norbital Convert, oss/services/convert)
export {
	httpOAuth,
	httpRequest,
	target,
	type HttpInstance,
	type HttpOptions
} from './integrations/http.ts'; // hook:hosting — every host's http driver (§2.6)
export {
	DatabaseRequest,
	DatabaseResult,
	validateDatabaseRequest,
	validateDatabaseResult,
	DATABASE_MAX_ROWS,
	DATABASE_MAX_BYTES,
	type DatabaseDriver,
	type DatabaseProjection
} from './integrations/database.ts';
// ── exports: conversations ──
export { ConversationsLive } from './conversations/index.ts';
export {
	filterDescribe,
	makeFilterDescribe,
	OPS_BY_KIND,
	ARGUMENT_OPERATORS,
	type Op,
	type Operator
} from './filter-describe/index.ts';
export { EnvoysLive, EnvoyConfig } from './envoys/index.ts';
export { TurnsLive, TurnHandlers } from './agent/turns.ts';
export {
	TriageLive,
	TriageService,
	TRIAGE_DEBOUNCE,
	TRIAGE_DEBOUNCE_MAX,
	TRIAGE_MAX_WAITS
} from './agent/triage.ts'; // hook:triage
export {
	isAutoReply,
	isReported,
	SendRefused,
	statusAfter,
	type DeliveryEntry,
	type DeliveryKind,
	type DeliveryReport
} from './conversations/status.ts'; // the delivery status model (§5.9)
// ── exports: agents ──
export { inferFacility } from './agent/ai.ts';
export { openAiChat, type OpenAiChat, type OpenAiChatConfig } from './agent/openai-chat.ts';
export type {
	AttachmentPort,
	HostSkill,
	HostTool,
	HostToolContext,
	WorkspacePort
} from './agent/index.ts'; // hook:wiring — hosts bind the agent's options
export { page } from './agent/context.ts'; // hook:wiring — a host's file-reading tool pages like `workspace_search` (rule 62)
export {
	AgentsLive,
	AgentDrains,
	AgentHost,
	type AgentConfig,
	type DrainOptions
} from './agent/index.ts';
export { BROWSER_RUN_PROFILE } from './agent/browser.ts'; // hook:wiring — the profile a host discards after a run
export { fileAttachments } from './agent/attachments.ts'; // hook:wiring — `read_attachment` over the files port
export { REFERENCE, ReferenceIndex } from './agent/run-js.ts'; // hook:wiring — a host's `reference` tool writes the index `run_js { file }` reads
// ── exports: protocol ──
export { BoltHost, BoltHostLive, ORDER, type Handler } from '../protocol/host.ts';
export { PublicPages, publicPages, renderMode } from '../protocol/pages.ts';
export {
	RateLimits,
	SessionAuthority,
	BoltRoutes,
	boltRoutes,
	needsGuest,
	dispatchAct,
	type ActCall
} from '../protocol/http.ts';
export { filesRoutes } from '../protocol/files.ts';
export { INTEGRATIONS } from '../protocol/wire.ts';
export { IntegrationManager, integrationRoutes, hookRoutes } from '../protocol/integrations.ts';
export {
	decodeStatus,
	localText,
	type InstanceState,
	type InstanceStatus,
	type LinkStatus,
	type LocalText,
	type Pairing,
	type ProviderChoice,
	type SetupDescription,
	type SetupField,
	type SetupStep,
	type TestSend
} from '../protocol/instance-status.ts';
export { statusOf, wireError } from '../protocol/wire.ts';
export { clientPage, MIME, type ClientPage } from '../protocol/static.ts';
export { TemplateManifest } from '../protocol/schema.ts';
// ── exports: shell ──
export {
	ShellRoutes,
	ShellHandler,
	HostIdentity,
	ShellConfig,
	Turnstile,
	authorityOf,
	type ShellHostConfig,
	type TurnstileShape
} from '../shell/host.ts';
export { COOKIES, cookieSite, framePolicy } from '../shell/nav.ts';
export { StudioInspectInput, StudioInspection } from '../shell/studio/inspection.ts';
export {
	StudioOp,
	studioView,
	type StudioApproval,
	type StudioBuild,
	type StudioBuildRecord,
	type StudioFile,
	type StudioUsage,
	type StudioChangeSet,
	type StudioPort,
	type StudioState
} from '../shell/studio/model.ts';
export type {
	AuditRuleSet,
	AuditRuleState,
	StudioAudit,
	StudioAuditFinding,
	StudioAuditPort,
	StudioAuditRule,
	StudioAuditRuleError,
	StudioAuditRules
} from '../shell/studio/audit.ts';
// ── exports: decl ──
export type {
	GeoHit,
	SpeechFormat,
	TranscribeOptions,
	Transcript,
	TranscriptSegment
} from '../decl/runtime/facilities.ts';

export { ImportStart, ImportStartInput, ImportStartCapability } from '../protocol/schema.ts';
