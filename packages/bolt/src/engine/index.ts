// One flat, Effect-native engine surface. Hosts own the runtime edge.
// ── exports: db ──
export { LIMITS } from './contracts.ts';
export type {
	Sql,
	Rows,
	RowData,
	Authority,
	FilesPort,
	AiRequest,
	AiResponse,
	DriverEvent,
	DriverPage,
	ReconcilePage,
	OutboundAttachment,
	TransportPort,
	LogRow,
	LogQuery,
	TcpSocket
} from './contracts.ts';
export {
	AuditEvent,
	AuditSummary,
	AuditRecord,
	AuditPreparedRecord,
	AuditQuery,
	AuditPendingQuery,
	type AuditPort
} from '../protocol/audit.ts';
export { DbError, Fenced, ManifestInvalid } from './errors.ts';
export { BoltError, CODE } from '../protocol/errors.ts';
export { Files, Convert, WebRead, Geo, Transport, Ai, Http } from './ports.ts';
export type { PushMessage } from './ports.ts';
export { Port, type PortFailure } from './port.ts';
export { TenantDb, type TenantDbShape } from './db/tenant-db.ts';
export {
	EngineManifest,
	decode_manifest,
	decode_projected_manifest,
	project_manifest,
	SKILL_BYTES,
	SKILL_FILE,
	SkillSchema
} from './manifest.ts';
export type { GrantData } from './manifest.ts';
export type { Json } from '../decl/values.ts';
// ── exports: guest ──
export type { GuestProgram } from './guest/runner.ts';
export { GuestTaken } from './guest/schema.ts';
export { decode_seed, type SeedPack } from './write/seed.ts';
export { read_pack, read_pack_source, type PackJson } from './write/pack.ts';
// ── exports: callables ──
export { size_bytes } from './callables/upload.ts';
export {
	DecisionResult,
	decisions_system_1,
	refusal_of,
	structured_system_1,
	type System1
} from './decision.ts';
// ── exports: identity ──
export { client_address } from './access/rate.ts';
export { logged_phone } from './identity/session.ts';
/** Host control-plane identity reads use the system table contract without loading a tenant artifact or guest. */
export { member_directory } from './identity/maintenance.ts';
export { plan, read_applied } from './schema/plan.ts'; // hook:hosting — Appendix D values (rule 69 activation)
export {
	apply_migrations,
	MigrationBundleSchema,
	migration_objects,
	migration_schema,
	read_migrations,
	type MigrationBundle
} from './schema/migrations.ts';
// ── exports: runs ──
export { DeadlineTimer } from './runs/deadlines.ts';
export { DOWNLOAD } from './files/media.ts';
// ── exports: links ──
export { OAUTH_CALLBACK } from './integrations/links.ts'; // hook:hosting — every host's instance links (§4.5)
export type { DriverOpen, Link, Provider } from './integrations/driver.ts'; // the one contract every provider implements
export { document_converter, document_ingester } from './convert.ts'; // the open-source ConvertPort (Norbital Convert, oss/services/convert)
export { http_oauth, http_request } from './integrations/http.ts'; // hook:hosting — every host's http driver (§2.6)
export {
	DatabaseRequest,
	DatabaseResult,
	validate_database_request,
	DATABASE_MAX_ROWS,
	DATABASE_MAX_BYTES,
	type DatabaseDriver
} from './integrations/database.ts';
export { SendRefused, SendReceipt, type DeliveryReport } from './conversations/status.ts';
export { open_ai_chat, type OpenAiChat, type OpenAiChatConfig } from './agent/openai-chat.ts';
export type { HostSkill, HostTool, HostToolContext } from './agent/index.ts'; // hook:wiring — hosts bind the agent's options
export { BROWSER_RUN_PROFILE, browser_profile } from './agent/browser.ts'; // hook:wiring — `read_attachment` over the files port
export { output_type, REFERENCE, ReferenceIndex, RUN_JS } from './agent/run-js.ts'; // A host's reference index also serves run_js file mode.
// ── exports: protocol ──
export {
	type InstanceState,
	type LinkStatus,
	type LocalText,
	type SetupDescription,
	type SetupField
} from '../protocol/instance-status.ts';
export { wire_error } from '../protocol/wire.ts';
// ── exports: shell ──
export { StudioInspectInput } from '../shell/studio/inspection.ts';
export {
	MERGE_SUMMARY,
	StudioOp,
	studio_view,
	suggest_message,
	type StudioPort,
	type StudioState
} from '../shell/studio/model.ts';
export { impact_lines } from '../protocol/migration-impact.ts';

