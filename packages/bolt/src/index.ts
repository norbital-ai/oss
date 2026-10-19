// @norbital-ai/bolt: the declaration functions and their types. Nothing else is a runtime value (P29).
export { collection } from './decl/collection.ts';
export { customField } from './decl/custom-field.ts';
export { model } from './decl/model.ts';
export { policy } from './decl/access/policy.ts';
export { team } from './decl/access/team.ts';
export type { TeamSpec, TeamEntry } from './decl/access/team.ts';
export { relationship } from './decl/relationship.ts';
export { envoy, mcp } from './decl/runtime/agent.ts';
export type { EnvoySpec } from './decl/runtime/agent.ts';
export { app, group, messages, secrets, workspace } from './decl/runtime/app.ts';
export { kiosk } from './decl/runtime/kiosk.ts';
export { automation } from './decl/runtime/automation.ts';
export { integration } from './decl/runtime/integration.ts';
export { pipeline } from './decl/runtime/pipeline.ts';
export { pageServer } from './decl/runtime/page.ts';
export type { PageData, PageLoad, PageLoadRequest, PageServer } from './decl/runtime/page.ts';
export { isMasked } from './decl/names.ts';

export type { Actor, Handle, PlatformAutomation } from './decl/access/actor.ts';
export type {
	Approval,
	ApprovalMatch,
	Edge,
	State,
	EnvoyLimit,
	Grant,
	IdentityGrant,
	Limit,
	LimitKey,
	OneRel,
	StateField,
	WriteField,
	WriteGrant
} from './decl/access/policy.ts';
export type {
	ActionSpec,
	AgentUse,
	CollectionSpec,
	NotificationEvent,
	OutputOf,
	QuerySpec,
	SimilarSpec,
	NotificationRule,
	Recipient,
	NotificationInput,
	NotificationRecipient,
	NotificationRecipients,
	Selection,
	UserField
} from './decl/collection.ts';
export type {
	Act,
	ActInput,
	ActOutput,
	ActionCtx,
	ActionName,
	AggRow,
	BodyError,
	Callable,
	CallerReads,
	Committed,
	MessageKey,
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
	QueryCtx,
	Revision,
	QueryName,
	MemberIn,
	MemberWhere,
	ReadMember,
	ReadSet,
	ReadSetAnswer,
	Refused,
	Select,
	StoredMember,
	StoredAnswer,
	WorkspaceReads,
	TransformCtx,
	TransformRow,
	Unknown
} from './decl/ctx.ts';
export type {
	FieldCommon,
	FieldKind,
	InputFields,
	InputKind,
	InputOf,
	Value,
	ValueOf
} from './decl/fields.ts';
export type { ComputedKind, Expr } from './decl/model.ts';
export type {
	AppName,
	AutomationName,
	BtreeField,
	CollectionName,
	CustomFieldName,
	FileField,
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
	OutboundState,
	RowApproval,
	RowState,
	PolicyName,
	ReadField,
	ReadableName,
	RelationshipSpec,
	Row,
	SkillName,
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
export type { AutomationCtx, Trigger } from './decl/runtime/automation.ts';
export type {
	ConvertOptions,
	ConvertSource,
	ConvertTarget,
	ConvertTargets,
	DecisionAnswers,
	DecisionQuestion,
	DecisionState,
	FileMeta,
	GeoHit,
	ImageFacts,
	InstanceTarget,
	Notice,
	Request,
	RunHandle,
	RunRow,
	Send,
	SpeakOptions,
	SpeechFormat,
	TranscribeOptions,
	Transcript,
	TranscriptSegment
} from './decl/runtime/facilities.ts';
export type {
	Attachment,
	CalendarEvent,
	CalendarTime,
	Change,
	ConfigurationOf,
	ConversationOf,
	DatabaseRequester,
	DeliveryEvent,
	DeliveryKind,
	DriverName,
	DriverOf,
	FeedCtx,
	FeedField,
	FeedPage,
	FeedRow,
	FeedSpec,
	Health,
	HttpOp,
	HttpRequester,
	InboundChat,
	InboundMail,
	Integration,
	IntegrationSpec,
	LocalField,
	MessageItem,
	Outgoing,
	OutboundSpec,
	ReadCtx,
	ReceivedChat,
	ReceivedMail,
	RequestOf,
	RequestResult,
	RunCtx,
	SendInput,
	TestCtx
} from './decl/runtime/integration.ts';
export type { ImportFinding, PipelineCtx } from './decl/runtime/pipeline.ts';
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

export type { ProjectReadCtx, ReadProjection } from './decl/collection.ts';

export type { Unavailable } from './decl/errors.ts';
