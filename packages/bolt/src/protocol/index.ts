// `@norbital-ai/bolt/protocol` (§3.3.10, Appendix D): the C8 wire and C9 artifact types, and nothing else — a host or a
// client written outside Bolt names its bodies with these. Types only: the paths, handlers and codecs stay internal.
import type { ArtifactJson } from '../compiler/artifact/read.ts';
import type { Json } from '../decl/values.ts';
import type { ActBody, ActReply, Frame, LiveBody, QBody, QReply, WireError } from './wire.ts';

/** `POST /__bolt/q`: reads, each `{ m, a }` as the guest names it. */
export type QueryRequest = QBody;
/** One answer per read, in order. */
export type QueryResponse = QReply | WireError;
/** `POST /__bolt/act` (headers `Idempotency-Key`, `Idempotency-Retry`, `Bolt-Contract`, `Bolt-Challenge`). */
export type ActRequest = ActBody;
/** A refusal is an outcome, never a thrown error; `WireError` is a transport failure. */
export type ActResponse = ActReply | WireError;
/** `POST /__bolt/live`: add or drop views on an open stream. */
export type LiveRegister = LiveBody;
/** One SSE frame of `GET /__bolt/live`. */
export type LiveFrame = Frame;
/** `PUT /__bolt/files/<collection>.<field>`: the client-minted upload id, and the challenge on a visitor upload. */
export type FileUploadHeaders = { 'Idempotency-Key': string; 'Bolt-Challenge'?: string };
/** `POST /__bolt/session/{code,verify,signout,invitation}`. */
export type SessionRequest =
	| { path: 'code'; body: { email: string } }
	| { path: 'verify'; body: { email: string; code: string } }
	| { path: 'signout'; body?: undefined }
	| { path: 'invitation'; body: { id: string } };
/** `verify` answers the user (and sets the session cookie); the others answer `null`. */
export type SessionResponse = { value: { user: string } | null } | WireError;
/** A host channel operation (§7.1: a host's private socket, or bolt-server's MAC-signed `POST /__bolt/ops`). */
export type HostOperation = { op: 'session.mint' | 'admit' | 'scope.set' | 'founder.bootstrap' | (string & {}); input: { readonly [k: string]: Json }; runId?: string };
export type HostOperationResult = { value: Json } | WireError;
/** C9: `.norbital/artifact/artifact.json`, what a host activates. */
export type ArtifactDescriptor = ArtifactJson;
/** The engine contract an artifact was built against (sha256 of the engine's name and version, hex). */
export type ContractDigest = ArtifactJson['contract'];
