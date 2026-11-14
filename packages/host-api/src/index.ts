// `@norbital-ai/host-api`: the contract between a host and a Bolt release. A host (Colony, bolt-server, a third
// party's) depends on this package, never on Bolt's engine; a release's Bolt depends on it and answers it. It owns
// every type that crosses: the `HostApi` a release answers (`host.ts`), the facilities and ports a host supplies
// (`facilities.ts`, `ai.ts`, `browser.ts`, `guest.ts`, `media.ts`, `integrations.ts`, `db.ts`, `logs.ts`, `audit.ts`),
// the authority a host reads (`authority.ts`), what a host adds to the agent (`tools.ts`) and Studio's port
// (`studio.ts`), with the failures they share (`errors.ts`), the `Port` helpers that call them and the SQL wire both
// database adapters and the engine share (`wire.ts`). It also holds the adapters every host binds the same way: System 1
// (`system-1.ts`), Norbital Convert (`convert.ts`) and the deadline timer (`deadline-timer.ts`).
//
// Versioning: the protocol version is `HOST_API_VERSION`, one integer bumped on any change either side could misread.
// The package version follows the oss release line for publication; what a host checks is the HOST_API number a
// release reports (`HostApiCore.version`), against the range it serves (`supports`).
//
// Node-only parts (signed host operations and the Node port implementations) are
// `@norbital-ai/host-api/node`; everything here also runs inside a cell.
export { HOST_API_VERSION, supports, type HostApiRange } from './version.ts';
export { HostApiFailure, HostDefect, HostFailure } from './failure.ts';
export { ArtifactHeader, FounderAnswer, MintedSession, ReleaseFacts } from './answers.ts';
export {
	MigrationImpact,
	MigrationStepImpact,
	impact_lines,
	impact_text,
	step_name
} from './migration-impact.ts';
export { is_off, off, type Off } from './off.ts';
export { uuidv7, uuidv7_within } from './uuid.ts';
export { Answer, CELL_ABI_VERSION, membrane, Message, type Membrane } from './membrane.ts';
export type { CellEnd, Kernel } from './cell.ts';
export { client_page, MIME, type ClientPage } from './client.ts';
export type { ArtifactPort, ArtifactStat, HostApiCore, Release, Signal } from './ports.ts';
export { conformance, type Check } from './conformance.ts';
export * from './errors.ts';
export { Port, provide_http, type HttpOptions, type Run } from './port.ts';
export * from './db.ts';
export { copiedBatch, copiedSql, db_error, param, parse, storedInstant } from './wire.ts';
export * from './logs.ts';
export * from './audit.ts';
export * from './authority.ts';
export * from './ai.ts';
export * from './browser.ts';
export * from './guest.ts';
export * from './media.ts';
export * from './integrations.ts';
export * from './facilities.ts';
export * from './tools.ts';
export * from './diagnostic.ts';
export * from './studio.ts';
export * from './host.ts';
export {
	DeadlineTimer,
	scope_deadlines,
	type DeadlineCompletion,
	type DeadlineEntry
} from './deadline-timer.ts';
export { model_schema } from './json-schema.ts';
export * from './system-1.ts';
export { document_converter, document_ingester, type DocumentConverter } from './convert.ts';
export { tree_digest, tree_hash } from './digest.ts';
