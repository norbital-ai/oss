// @norbital-ai/bolt: author declarations, small composition helpers and their types. Native services use separate entries.
export { custom_field } from './decl/custom-field.ts';
export { policy } from './decl/access/policy.ts';
export { team } from './decl/access/team.ts';
export { mcp } from './decl/runtime/agent.ts';
export { app, group, messages, secrets, workspace } from './decl/runtime/app.ts';
export { automation } from './decl/runtime/automation.ts';
export { browser_start } from './decl/runtime/facilities.ts';
export { seeder } from './decl/seeder.ts';
export { id_of } from './decl/id.ts';
export { instance_id, is_instance } from './decl/runtime/integration.ts';

export type { Actor } from './decl/access/actor.ts';
export type { ApprovalFlow, Verdict } from './decl/access/policy.ts';
export type {
	ActInput,
	ActOutput,
	BodyError,
	Callable,
	CreatedRow,
	CarriedWrites,
	Clock,
	CreateInput,
	Eff,
	IndexSearch,
	MessageKey,
	Cursor,
	ListRow,
	Outcome,
	Page,
	PolicyCtx,
	ReadAnswer,
	ReadRequest,
	ReadRequestBase,
	StoredTree,
	UpdateInput,
	WorkspaceQuery,
	WriteCtx
} from './decl/ctx.ts';
export type { InputFields, InputOf, ValueOf } from './decl/fields.ts';
export type {
	Names,
	ModelName,
	InstanceId,
	Row,
	StoredRow
} from './decl/names.ts';
export type { Check, Verify } from './decl/verify.ts';
export type {
	CurrencyCode,
	Decimal,
	Duration,
	FileRef,
	Id,
	Instant,
	Json,
	PlainDate,
	PlainTime,
	Point
} from './decl/values.ts';
export type { LayerWhere, Where } from './decl/where.ts'; // hook:query (OrderBy)
export type { AutomationCtx, EffectCtx } from './decl/runtime/automation.ts';
export type { ImageFacts, StartInput } from './decl/runtime/facilities.ts';
export type { Attachment, CalendarEvent } from './decl/runtime/integration.ts';
export type { Finding, Health, RemoteSync, SyncCtx, FileSyncCtx, SyncRow } from './decl/runtime/sync.ts';
export type { CustomFieldView, RecordView } from './shell/runtime.ts'; // hook:packaging-ui — X-20 and role 5's view props

export { input_schema, type Kind, type Value } from '@norbital-ai/store/kind'; // field kinds: the authoring language
export { compile, context, evaluate, formula } from '@norbital-ai/store/formula'; // user-edited CEL rules
