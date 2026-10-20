// One flat, Effect-native engine surface. Hosts activate EngineLive and own the runtime edge.
// ── exports: db ──
export * from './contracts.ts';
export * from './errors.ts';
export { BoltError, CODE, CODES, PHASES, type Code, type Phase } from '../protocol/errors.ts';
export * from './services.ts';
export * from './ports.ts';
export { Port, type PortFailure } from './port.ts';
export * from './host.ts';
export { Secrets, type SecretsCodec, type SecretsShape } from './secrets.ts';
export { TenantDb, TenantTx, type TenantDbShape, type RawDb } from './db/tenant-db.ts';
export { PostgresDb, type PgClient, type PgPool } from './db/postgres.ts';
export { PgliteDb, Pristine, type PgliteClient, type PgliteSource } from './db/pglite.ts';
export * from './manifest.ts';
export type { Json } from '../decl/values.ts';
// ── exports: query ──
export * as ir from '../protocol/ir.ts';
export {
	ReadsLive,
	readEngine,
	memoReads,
	coalescing,
	readComposed,
	lowerRead,
	type SimilarityBodies
} from './query/engine.ts';
export { historyAt } from '../protocol/ir.ts';
export { readProjector, projectionContext } from './query/read-projector.ts';
export { readHistory, pruneHistory } from './query/history.ts';
// ── exports: guest ──
export {
	GuestConfig,
	GuestLive,
	IsolatesLive,
	PreparedIsolates,
	type GuestOptions,
	type GuestProgram
} from './guest/runner.ts';
export { TelemetryLive, EventLine, eventsPiece, type SysEvent } from './guest/telemetry.ts';
// ── exports: writes ──
export { WritesLive, act, recordCapabilities, mayUpdate, type WriteEngine } from './write/act.ts';
export {
	canonical,
	sha256Hex,
	minter,
	databaseValue,
	fingerprinting,
	ownPredSql,
	Chain
} from './write/sql.ts';
export { decodeSeed, seed, type SeedPack } from './write/seed.ts';
export { loadPack, readPack, type Pack, type PackJson } from './write/pack.ts';
// ── exports: callables ──
export {
	CallablesLive,
	readQuery,
	parseCallable,
	VERBS,
	admitVisitor,
	forActor
} from './callables/index.ts';
export { upload, sizeBytes } from './callables/upload.ts';
export {
	ApprovalsLive,
	approvalHook,
	type ApprovalView,
	type DecideInput,
	type Decision
} from './approvals/approvals.ts';
export { PipelinesLive, csv } from './pipelines/pipeline.ts';
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
	admits,
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
	type Keys,
	type PhoneVerifier,
	type Session,
	type Signup,
	type TransactionalProvider
} from './identity/session.ts';
export { assignTeam, membershipRun } from './identity/members.ts'; // Source-team affiliation; hosts bind membershipRun as runs.platform['bolt.membership'].
export { MEMBERSHIP } from './identity/session.ts';
export { applyPlan, plan, readApplied } from './schema/plan.ts'; // hook:hosting — Appendix D values (rule 69 activation)
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
	queueTriggered,
	triggersOf,
	type Triggers,
	type EventTrigger,
	type CronTrigger,
	type WebhookTrigger
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
	EventRetention,
	RUN_VIEW_COLUMNS,
	RunViewRow,
	runView,
	type RunView
} from './runs/index.ts';
export { NOTICE_PUSH, noticePush, subscribe } from './runs/push.ts';
export { imageFacts, imageJpeg, type ImageFacts } from './files/image.ts';
// ── exports: links ──
export {
	isPublicWebAddress,
	publicDestination,
	pinnedLookup,
	connectPublic,
	makeRequestPage,
	publicAddresses,
	publicFetch,
	WEB_PAGE_BYTE_LIMIT,
	type Address,
	type Resolve,
	type PageWrite
} from './net.ts'; // hook:hosting — the outbound guard (L-BOLT-366)
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
// ── exports: feeds ──
export {
	FacilitiesLive,
	facilityDispatch,
	fileLoader,
	localFiles,
	loggedTransport,
	type FacilityPorts
} from './facilities.ts';
export { FeedsLive, feedsOf, fedOf } from './integrations/feeds.ts';
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
	DATABASE_MAX_PARAMETERS,
	DATABASE_MAX_ROWS,
	DATABASE_MAX_BYTES,
	type DatabaseDriver
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
	HostTool,
	HostToolContext,
	SandboxPort,
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
export { fileAttachments } from './agent/attachments.ts'; // hook:wiring — `read_attachment` over the files port
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
export {
	StudioOp,
	studioView,
	type StudioBuild,
	type StudioBuildRecord,
	type StudioMergeRequest,
	type StudioPort,
	type StudioState
} from '../shell/studio/model.ts';
// ── exports: decl ──
export type {
	GeoHit,
	SpeechFormat,
	TranscribeOptions,
	Transcript,
	TranscriptSegment
} from '../decl/runtime/facilities.ts';

export { ImportStart, ImportStartInput, ImportStartCapability } from '../protocol/schema.ts';
