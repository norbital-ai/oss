// One flat, Effect-native engine surface. Hosts own the runtime edge.
// ── exports: db ──
export { LIMITS } from './contracts.ts';
export type { RowData, Authority } from './contracts.ts';
export { ManifestInvalid } from './errors.ts';
export { BoltError } from '../protocol/errors.ts';
export { Files, Convert, Render, WebRead, Geo, Transport, Ai, Http } from './ports.ts';
// what a test's fake port speaks: the Host API values the ports above take and answer (templates depend on Bolt alone)
export {
	DatabaseRequest,
	DbError,
	DecisionResult,
	Port,
	type AiRequest,
	type AiResponse,
	type DatabaseResult,
	type DriverOpen,
	type PortFailure,
	type Provider
} from '@norbital-ai/host-api';
export { validate_database_request } from './integrations/database.ts';
export type { PushMessage } from './ports.ts';
export { TenantDb, type TenantDbShape } from './db/tenant-db.ts';
export {
	EngineManifest,
	decode_manifest,
	decode_projected_manifest,
	project_manifest
} from './manifest.ts';
export type { GrantData } from './manifest.ts';
export type { Json } from '../decl/values.ts';
// ── exports: guest ──
export { decode_seed, type SeedPack } from './write/seed.ts';
export { read_pack, read_pack_source, type PackJson } from './write/pack.ts';
// ── exports: callables ──
export { size_bytes } from './callables/upload.ts';
// ── exports: identity ──
export { plan, read_applied } from './schema/plan.ts'; // hook:hosting — Appendix D values
export {
	apply_migrations,
	MigrationBundleSchema,
	migration_objects,
	migration_schema,
	read_migrations,
	type MigrationBundle
} from './schema/migrations.ts';
// ── exports: links ──
export { open_ai_chat, type OpenAiChatConfig } from './agent/openai-chat.ts';
export { output_type, RUN_JS } from './agent/run-js.ts';
// ── exports: protocol ──
export { wire_error } from '../protocol/wire.ts';

