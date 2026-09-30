// @norbital-ai/bolt: the declaration functions and their types. Nothing else is a runtime value (P29).
export { collection } from './decl/collection.ts';
export { customField } from './decl/custom-field.ts';
export { model } from './decl/model.ts';
export { policy } from './decl/access/policy.ts';
export { team } from './decl/access/team.ts';
export { relationship } from './decl/relationship.ts';
export { envoy, mcp } from './decl/runtime/agent.ts';
export { app, group, messages, workspace } from './decl/runtime/app.ts';
export { automation } from './decl/runtime/automation.ts';
export { channel } from './decl/runtime/channel.ts';
export { connection } from './decl/runtime/connection.ts';
export { integration, pipeline } from './decl/runtime/integration.ts';

export type { Actor, Handle, PlatformAutomation } from './decl/access/actor.ts';
export type {
	Approval, ApprovalMatch, Edge, State, EnvoyLimit, Grant, IdentityGrant, Limit, LimitKey, OneRel, StateField,
	WriteField, WriteGrant
} from './decl/access/policy.ts';
export type {
	ActionSpec, AgentUse, CollectionSpec, NotificationEvent, OutputOf, QuerySpec, SimilarSpec, NotificationRule,
	Recipient, Selection, UserField
} from './decl/collection.ts';
export type {
	Act, ActInput, ActOutput, ActionCtx, ActionName, AggRow, Callable, Committed, MessageKey, QueryInput, QueryOutput, Conflict,
	Cursor, Insert, KeyValues, ListRow, Live, Outcome, Page, Paged, Patch, PendingApproval, PlatformRefusal, Q, QueryCtx, Revision,
	QueryName, Refused, Select, TransformCtx, TransformRow, Unknown
} from './decl/ctx.ts';
export type { FieldCommon, FieldKind, InputFields, InputKind, InputOf, Value, ValueOf } from './decl/fields.ts';
export type { ComputedKind, Expr } from './decl/model.ts';
export type {
	AppName, AutomationName, BtreeField, ChannelName, CollectionName, CustomFieldName, FileField, PeriodField, RelName,
	RelPath, RequiredBtreeField, SearchableField, TextField, VectorField, EnvoyName, FieldName, HostToolName, McpName,
	ModelName, Masked, Names, PersonChannelName, PolicyName, ReadField, RelationshipSpec, Row, SkillName, TeamName
} from './decl/names.ts';
export type { Check, Verify } from './decl/verify.ts';
export type {
	AssetPath, CurrencyCode, DatePeriod, Decimal, Duration, FileRef, IanaZone, IconName, Id, InputName, Instant,
	InstantPeriod, LocaleTag, MimePattern, Msg, Offset, PlainDate, PlainTime, RequestId, Point, RecordRef, Seconds, Size,
	Rate, Vector
} from './decl/values.ts';
export type { Operand, OrderBy, Shape, StaticWhere, Where } from './decl/where.ts'; // hook:query (OrderBy)
export type { AutomationCtx, Trigger } from './decl/runtime/automation.ts';
export type { DeliveryEvent, OutboundFor } from './decl/runtime/channel.ts';
export type {
	ConvertOptions, ConvertSource, ConvertTarget, ConvertTargets, DecisionAnswers, DecisionQuestion, DecisionState, FileMeta, GeoHit,
	ImageFacts, Notice, RunHandle, RunRow, SpeakOptions, SpeechFormat, TranscribeOptions, Transcript, TranscriptSegment, Unavailable
} from './decl/runtime/facilities.ts';
export type { ConflictRule, IntegrationCtx, IntegrationSource, Remote, RemoteKey } from './decl/runtime/integration.ts';
export type { AiModelClass, ChildName, ConnectionName, DeclaredConvertTarget, EmbeddingModelName, EnvName, PageName, Transport } from './decl/runtime/names.ts';
export type { BankReader, SeedSource } from './compiler/artifact/seed.ts'; // hook:cli — X-15's seed reader types (§3.3.10)
export type { CustomFieldView, RecordView } from './shell/runtime.ts'; // hook:packaging-ui — X-20 and role 5's view props
