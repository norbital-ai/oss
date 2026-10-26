// @norbital-ai/bolt: the declaration functions and their types. Nothing else is a runtime value (P29).
export { customField } from './decl/custom-field.ts';
export type { CustomField } from './decl/custom-field.ts';
export { model } from './decl/model.ts';
export { policy } from './decl/access/policy.ts';
export { team } from './decl/access/team.ts';
export type { SourceTeam, TeamData, TeamEntries, TeamEntry, TeamSpec } from './decl/access/team.ts';
export { envoy, mcp } from './decl/runtime/agent.ts';
export type { EnvoySpec } from './decl/runtime/agent.ts';
export { app, group, messages, secrets, workspace } from './decl/runtime/app.ts';
export type { AppSpec, DeviceRequirement, EmbedOrigin, GroupSpec } from './decl/runtime/app.ts';
export { kiosk } from './decl/runtime/kiosk.ts';
export type { KioskSpec } from './decl/runtime/kiosk.ts';
export { automation } from './decl/runtime/automation.ts';
export { integration, instanceId, isInstance } from './decl/runtime/integration.ts';
export { pageServer } from './decl/runtime/page.ts';
export type { PageData, PageLoad, PageLoadRequest, PageServer } from './decl/runtime/page.ts';
export { isMasked } from './decl/names.ts';
/** Pure: what changed between two JSON values, keyed list items matched by key (a reviewed draft's changes). */
export { jsonDiff } from './engine/agent/draft.ts';
export type { JsonChange } from './engine/agent/draft.ts';

export type { Actor, Handle, PlatformAutomation } from './decl/access/actor.ts';
export type {
	ApprovalSnapshot,
	ApprovalStep,
	ApprovalWrite,
	Edge,
	State,
	EnvoyLimit,
	Flow,
	Grant,
	IdentityGrant,
	Limit,
	LimitKey,
	OneRel,
	StartableName,
	StateField,
	WriteField,
	WriteGrant
} from './decl/access/policy.ts';
export type { AgentUse, OutputOf } from './decl/body.ts';
export type {
	CollectionSpec,
	ComputedKind,
	Expr,
	Model,
	ModelBodies,
	ModelLiteral,
	ModelParts,
	ModelSpec,
	QuerySpec,
	RefField,
	SearchIndexSpec,
	Selection,
	SyncEntry,
	TableSpec
} from './decl/model.ts';
export type {
	Act,
	ActBatch,
	ActManyInput,
	ActManyOutput,
	ActInput,
	ActOutput,
	AggRow,
	BodyError,
	BodyReturn,
	Bucket,
	BucketField,
	Callable,
	CallerQuery,
	Clock,
	Committed,
	CreateRow,
	Eff,
	HistoryOptions,
	Hit,
	IndexSearch,
	MessageKey,
	Measures,
	NotifyCtx,
	NotifyEvent,
	QueryInput,
	QueryOutput,
	Conflict,
	Cursor,
	DeclaredQuery,
	DeclaredRow,
	Insert,
	KeyValues,
	ListRow,
	Outcome,
	Page,
	PageReadContext,
	Paged,
	Patch,
	PendingApproval,
	PlatformRefusal,
	QueryCallable,
	QueryCtx,
	Revision,
	QueryMember,
	QueryName,
	QuerySet,
	QuerySetAnswer,
	MemberIn,
	MemberWhere,
	Refused,
	Running,
	Select,
	StoredMember,
	StoredAnswer,
	Unknown,
	UpdateSet,
	WorkspaceQuery,
	WriteCtx
} from './decl/ctx.ts';
export type {
	Transaction,
	TxAct,
	TxApplied,
	TxCtx,
	TxInstruction,
	TxStep,
	TxValue
} from './decl/transaction.ts';
export type {
	FieldCommon,
	FieldKind,
	InputFields,
	InputKind,
	OutputKind,
	InputOf,
	Value,
	ValueOf
} from './decl/fields.ts';
export type {
	AppName,
	AutomationName,
	BtreeField,
	CollectionName,
	CustomFieldName,
	FileField,
	FileSyncName,
	IndexName,
	PeriodField,
	RelName,
	RelPath,
	RequiredBtreeField,
	SearchableField,
	TextField,
	VectorField,
	EnvoyName,
	FieldName,
	HostToolName,
	InstanceId,
	IntegrationName,
	KioskName,
	McpName,
	ModelName,
	Masked,
	Names,
	RowApproval,
	RowState,
	PolicyName,
	ReadField,
	ReadableName,
	RelationshipSpec,
	Row,
	SkillName,
	StoredRow,
	SyncCallable,
	SyncName,
	SyncState,
	TeamName
} from './decl/names.ts';
export type { Check, Verify } from './decl/verify.ts';
export type {
	AssetPath,
	CurrencyCode,
	DatePeriod,
	Decimal,
	Duration,
	FileRef,
	IanaZone,
	IconName,
	Id,
	InputName,
	Instant,
	InstantPeriod,
	LocaleTag,
	MimePattern,
	Msg,
	Offset,
	PlainDate,
	PlainTime,
	RequestId,
	Point,
	RecordRef,
	Seconds,
	Size,
	Rate,
	Vector
} from './decl/values.ts';
export type { Operand, OrderBy, Shape, StaticWhere, Where } from './decl/where.ts'; // hook:query (OrderBy)
export type {
	Automation,
	AutomationCtx,
	AutomationSpec,
	Cron,
	RunInput,
	RunOutput,
	Trigger,
	WebhookScheme
} from './decl/runtime/automation.ts';
export type {
	Ai,
	Convert,
	ConvertOptions,
	ConvertRequest,
	ConvertSource,
	ConvertTarget,
	ConvertTargets,
	DecisionAnswers,
	DecisionQuestion,
	DecisionState,
	FileMeta,
	Files,
	Geo,
	GeoHit,
	ImageFacts,
	InstanceTarget,
	Notice,
	NoticeAttachment,
	Notify,
	Recipient,
	Request,
	RunCause,
	RunHandle,
	RunRow,
	RunStatus,
	Schedule,
	Send,
	SpeakOptions,
	SpeechFormat,
	StartInput,
	FileSyncStartInput,
	StartOutput,
	TranscribeOptions,
	Transcript,
	TranscriptSegment,
	Web,
	WebPage
} from './decl/runtime/facilities.ts';
export type {
	Attachment,
	CalendarEvent,
	CalendarTime,
	ConfigurationOf,
	ConversationOf,
	DatabaseRequester,
	DeliveryEvent,
	DeliveryKind,
	DeliveryOf,
	DriverItemOf,
	DriverName,
	DriverOf,
	HandleKind,
	HttpOp,
	HttpRequester,
	Inbound,
	InboundChat,
	InboundMail,
	Integration,
	IntegrationSpec,
	MessageDelivery,
	MessageItem,
	Outgoing,
	RequestOf,
	RequestResult,
	RequesterOf,
	SendInput,
	TestCtx,
	WebhookDelivery
} from './decl/runtime/integration.ts';
export type {
	BuiltinParser,
	CustomParser,
	FileReadInput,
	FileReadResult,
	FileRecord,
	FileSync,
	FileWriteInput,
	FileWriteResult,
	Finding,
	Health,
	RemoteReadInput,
	RemoteReadResult,
	RemoteSync,
	RemoteWriteResult,
	SyncChange,
	SyncCtx,
	SyncRow,
	SyncSpec
} from './decl/runtime/sync.ts';
export type { MediaType } from './decl/media-types.ts';
export type {
	AiModelClass,
	ChildName,
	ConnectionName,
	DeclaredConvertTarget,
	EmbeddingModelName,
	IntegrationOf,
	KioskPageName,
	PageName,
	SecretName
} from './decl/runtime/names.ts';
export type { BankReader, SeedSource } from './compiler/artifact/seed.ts'; // hook:cli — X-15's seed reader types (§3.3.10)
export type { CustomFieldView, RecordView } from './shell/runtime.ts'; // hook:packaging-ui — X-20 and role 5's view props

export type { Unavailable } from './decl/errors.ts';
