// `@norbital-ai/bolt/protocol` (§3.3.10, Appendix D): the C8 wire and C9 artifact types — a host or a client written
// outside Bolt names its bodies with these. Public reply/error Schemas validate transport boundaries;
// TemplateManifest decodes norbital.template.json for the catalogue, host picker and website.
// The paths and handlers stay internal.
import type { ArtifactJson } from '../engine/artifact/read.ts';
import type * as S from './schema.ts';

export { TemplateManifest } from './schema.ts';
export { ActReply, QReply, WireError } from './schema.ts';
export { MIME, clientPage, type ClientPage } from './static.ts';

/** `POST /__bolt/q`: reads, each `{ m, a }` as the guest names it. */
export type QueryRequest = S.QBody;
/** One answer per read, in order. */
export type QueryResponse = S.QReply | S.WireError;
/** `POST /__bolt/act` (headers `Idempotency-Key`, `Idempotency-Retry`, `Bolt-Contract`, `Bolt-Challenge`). */
export type ActRequest = S.ActBody;
/** A refusal is an outcome, never a thrown error; `WireError` is a transport failure. */
export type ActResponse = S.ActReply | S.WireError;
/** `POST /__bolt/live`: add or drop views on an open stream. */
export type LiveRegister = S.LiveBody;
/** One SSE frame of `GET /__bolt/live`. */
export type LiveFrame = S.Frame;
/** `PUT /__bolt/files/<collection>.<field>`: the client-minted upload id, and the challenge on a visitor upload. */
export type FileUploadHeaders = { 'Idempotency-Key': string; 'Bolt-Challenge'?: string };
/** `POST /__bolt/session/{code,verify,signout,invitation}`. */
export type SessionRequest = S.SessionRequest;
/** `verify` answers the user (and sets the session cookie); the others answer `null`. */
export type SessionResponse = S.SessionResponse;
/** A host channel operation (§7.1: a host's private socket, or bolt-server's MAC-signed `POST /__bolt/ops`). */
export type HostOperation = S.HostOperation;
export type HostOperationResult = S.HostOperationResult;
/** C9: `.norbital/artifact/artifact.json`, what a host activates. */
export type ArtifactDescriptor = ArtifactJson;
/** The engine contract an artifact was built against (sha256 of the engine's name and version, hex). */
export type ContractDigest = ArtifactJson['contract'];
