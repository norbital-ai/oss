import { Schema } from 'effect';
import { InvocationScope } from './invocation.js';
import {
	EffectId,
	FacilityCall,
	FacilityResult,
	LeaseId,
	ReleaseId
} from './wire.js';

export const DatabaseRequest = Schema.TaggedUnion({
	Query: { sql: Schema.NonEmptyString, parameters: Schema.Array(Schema.Json) },
	Transaction: {
		statements: Schema.Array(
			Schema.Struct({ sql: Schema.NonEmptyString, parameters: Schema.Array(Schema.Json) })
		)
	}
});
export type DatabaseRequest = typeof DatabaseRequest.Type;
export const DatabaseResponse = Schema.Struct({ rows: Schema.Array(Schema.Json), affectedRows: Schema.Number });
export interface DatabaseResponse extends Schema.Schema.Type<typeof DatabaseResponse> {}

// `Write` carried a `contentType` until it was noticed that nothing could ever honour it: no binding
// persisted it, and `FileResponse` has no field to return it in, so the media type of a stored object
// was unrecoverable by construction. Persisting it would mean a second field here, a matching field
// on `FileResponse`, and a per-object metadata sidecar invented in all three bindings — a storage
// convention that does not exist yet, to serve one consumer that already has a working answer:
// `api/files/[...key]` derives the media type from the key's extension and sends `nosniff`, which is
// safer than echoing a caller-supplied type anyway. A wire field no implementation can satisfy is a
// promise to consumers, so it is deleted rather than left to look supported.
export const FileRequest = Schema.TaggedUnion({
	Read: { key: Schema.NonEmptyString },
	Write: { key: Schema.NonEmptyString, bytes: Schema.Uint8Array },
	Delete: { key: Schema.NonEmptyString },
	List: { prefix: Schema.String }
});
export type FileRequest = typeof FileRequest.Type;
export const FileResponse = Schema.Struct({
	key: Schema.optionalKey(Schema.String),
	bytes: Schema.optionalKey(Schema.Uint8Array),
	keys: Schema.optionalKey(Schema.Array(Schema.String)),
	etag: Schema.optionalKey(Schema.String)
});
export interface FileResponse extends Schema.Schema.Type<typeof FileResponse> {}

export const AIRequest = Schema.TaggedUnion({
	Models: {},
	Turn: {
		model: Schema.NonEmptyString,
		messages: Schema.Array(Schema.Json),
		tools: Schema.Array(Schema.Json),
		maxOutputTokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
	}
});
export type AIRequest = typeof AIRequest.Type;
export const AIResponse = Schema.Struct({ output: Schema.Json, usage: Schema.optionalKey(Schema.Json) });
export interface AIResponse extends Schema.Schema.Type<typeof AIResponse> {}

export const CommunicationRequest = Schema.TaggedUnion({
	VerifyInbound: { channel: Schema.NonEmptyString, envelope: Schema.Json },
	Send: { channel: Schema.NonEmptyString, recipient: Schema.NonEmptyString, payload: Schema.Json },
	Notify: { recipient: Schema.NonEmptyString, payload: Schema.Json },
	Wake: { topic: Schema.NonEmptyString }
});
export type CommunicationRequest = typeof CommunicationRequest.Type;
export const CommunicationResponse = Schema.Struct({ receipt: Schema.optionalKey(Schema.Json) });
export interface CommunicationResponse extends Schema.Schema.Type<typeof CommunicationResponse> {}

export const ConnectorRequest = Schema.Struct({
	connector: Schema.NonEmptyString,
	operation: Schema.NonEmptyString,
	input: Schema.Json
});
export interface ConnectorRequest extends Schema.Schema.Type<typeof ConnectorRequest> {}
export const ConnectorResponse = Schema.Struct({ output: Schema.Json });
export interface ConnectorResponse extends Schema.Schema.Type<typeof ConnectorResponse> {}

export const TaskRequest = Schema.TaggedUnion({
	/**
	 * Hands the host a durable callback for the life of this release.
	 *
	 * `schedule` and `input` are what make a registration recurring: present, they say "invoke
	 * `command` with `input` on this cron until the release is superseded"; absent, the registration
	 * only tells the host where to route work that something else enqueues. They are `optionalKey`
	 * because most registrations genuinely have neither — a routing-only registration should not have
	 * to write two nulls to say so.
	 */
	Register: {
		leaseId: LeaseId,
		releaseId: ReleaseId,
		command: Schema.NonEmptyString,
		schedule: Schema.optionalKey(Schema.NonEmptyString),
		input: Schema.optionalKey(Schema.Json)
	},
	Enqueue: { command: Schema.NonEmptyString, input: Schema.Json },
	Schedule: { command: Schema.NonEmptyString, input: Schema.Json, runAtEpochMs: Schema.Number },
	Cancel: { taskId: Schema.NonEmptyString },
	Signal: { taskId: Schema.NonEmptyString, signal: Schema.NonEmptyString, input: Schema.Json }
});
export type TaskRequest = typeof TaskRequest.Type;
export const TaskResponse = Schema.Struct({ taskId: Schema.optionalKey(Schema.String) });
export interface TaskResponse extends Schema.Schema.Type<typeof TaskResponse> {}

export const HostToolRequest = Schema.Struct({ tool: Schema.NonEmptyString, input: Schema.Json });
export interface HostToolRequest extends Schema.Schema.Type<typeof HostToolRequest> {}
export const HostToolResponse = Schema.Struct({ output: Schema.Json });
export interface HostToolResponse extends Schema.Schema.Type<typeof HostToolResponse> {}

/**
 * Identity lifecycle the host may project, never originate.
 *
 * Bolt owns users, invitations, and sessions. Colony keeps only a user → organization map so the
 * organization selector can list workspaces a person already belongs to. These events are that
 * projection's input. They are a facility rather than `Communication.Notify` because Notify is a
 * message to a person; this is an observation the host stores.
 */
export const IdentityHookRequest = Schema.TaggedUnion({
	UserInvited: {
		invitationId: Schema.NonEmptyString,
		organizationId: Schema.NonEmptyString,
		email: Schema.NonEmptyString,
		invitedBy: Schema.NonEmptyString,
		userId: Schema.optionalKey(Schema.NonEmptyString)
	},
	UserChanged: {
		userId: Schema.NonEmptyString,
		organizationId: Schema.NonEmptyString,
		email: Schema.optionalKey(Schema.NonEmptyString),
		roles: Schema.Array(Schema.NonEmptyString),
		teams: Schema.Array(Schema.NonEmptyString)
	},
	MembershipChanged: {
		userId: Schema.NonEmptyString,
		organizationId: Schema.NonEmptyString,
		email: Schema.optionalKey(Schema.NonEmptyString),
		action: Schema.Literals(['joined', 'left', 'role_changed']),
		role: Schema.optionalKey(Schema.NonEmptyString)
	}
});
export type IdentityHookRequest = typeof IdentityHookRequest.Type;
export const IdentityHookResponse = Schema.Struct({ acknowledged: Schema.Boolean });
export interface IdentityHookResponse extends Schema.Schema.Type<typeof IdentityHookResponse> {}

export const TransportProtocol = Schema.Literals(['sse', 'websocket']);
export type TransportProtocol = typeof TransportProtocol.Type;

export const TransportDirection = Schema.Literals(['one-way', 'two-way']);
export type TransportDirection = typeof TransportDirection.Type;

export const TransportFrameKind = Schema.Literals(['text', 'binary']);
export type TransportFrameKind = typeof TransportFrameKind.Type;

export const TransportFrame = Schema.Struct({
	sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	kind: TransportFrameKind,
	bytes: Schema.Uint8Array,
	cursor: Schema.optionalKey(Schema.NonEmptyString)
});
export interface TransportFrame extends Schema.Schema.Type<typeof TransportFrame> {}

export const TransportRequest = Schema.TaggedUnion({
	Open: {
		protocol: TransportProtocol,
		direction: TransportDirection,
		topic: Schema.optionalKey(Schema.NonEmptyString)
	},
	Send: {
		connectionId: Schema.NonEmptyString,
		kind: TransportFrameKind,
		bytes: Schema.Uint8Array
	},
	/**
	 * Addresses a topic rather than a connection, so a caller that holds neither can still reach the
	 * clients listening on one.
	 *
	 * `Send` needs a `connectionId`, which is exactly what a stateless Bolt does not have: an
	 * invocation is created for one command and disposed after it, so it never held the connection a
	 * browser opened and has nowhere to remember it. The host does hold them, and knows which belong
	 * to the tenant this invocation is scoped to, so naming the topic is the whole of the address.
	 *
	 * This is the direction the sync engine needs and the only one it needs: the host tells a replica
	 * that something changed, and the replica asks for the changes over the ordinary command channel.
	 * Nothing about the data travels this way, which is what keeps the frame a hint rather than a
	 * second, weaker copy of the log.
	 */
	Publish: {
		topic: Schema.NonEmptyString,
		kind: TransportFrameKind,
		bytes: Schema.Uint8Array
	},
	Pull: {
		connectionId: Schema.NonEmptyString,
		afterCursor: Schema.optionalKey(Schema.String),
		maxFrames: Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThan(0),
			Schema.isLessThanOrEqualTo(256)
		)
	},
	Close: {
		connectionId: Schema.NonEmptyString,
		reason: Schema.optionalKey(Schema.String)
	}
});
export type TransportRequest = typeof TransportRequest.Type;

export const TransportResponse = Schema.Struct({
	connectionId: Schema.optionalKey(Schema.NonEmptyString),
	frames: Schema.optionalKey(Schema.Array(TransportFrame)),
	closed: Schema.optionalKey(Schema.Boolean),
	/**
	 * How many connections a `Publish` reached. Zero is an ordinary answer — nobody is watching — and
	 * is reported rather than treated as a failure, because a workspace with no open tab is the common
	 * case and must not look like a broken transport.
	 */
	delivered: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
});
export interface TransportResponse extends Schema.Schema.Type<typeof TransportResponse> {}

/**
 * Every host facility uses this call shape. Colony and bolt-server bind physical
 * effects here; Bolt capabilities (channels, sync, automations) only invoke it.
 */
export type FacilityBinding<Input, Output> = Readonly<{
	readonly call: (
		metadata: FacilityCall,
		input: Input,
		signal: AbortSignal
	) => Promise<FacilityResult<Output>>;
}>;

export type FacilityBindings = Readonly<{
	readonly scope: InvocationScope;
	readonly database?: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	readonly files?: FacilityBinding<FileRequest, FileResponse>;
	readonly ai?: FacilityBinding<AIRequest, AIResponse>;
	readonly communication?: FacilityBinding<CommunicationRequest, CommunicationResponse>;
	readonly connector?: FacilityBinding<ConnectorRequest, ConnectorResponse>;
	readonly tasks?: FacilityBinding<TaskRequest, TaskResponse>;
	readonly hostTools?: FacilityBinding<HostToolRequest, HostToolResponse>;
	readonly identityHooks?: FacilityBinding<IdentityHookRequest, IdentityHookResponse>;
	readonly transport?: FacilityBinding<TransportRequest, TransportResponse>;
}>;

/** Owns immutable facility-call correlation metadata assembly. */
const FacilityCalls = {
	forEffect: (call: Omit<FacilityCall, 'effectId'>, effectId: EffectId): FacilityCall => ({ ...call, effectId })
};
export const facilityCallFor = FacilityCalls.forEffect;
