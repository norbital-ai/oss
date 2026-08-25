import { Effect, Schema } from 'effect';
import { AgentEnqueueResult } from '#lib/runtime/agents/agent-schemas.js';
import { ChatDocumentRef } from '#lib/runtime/agents/chat-messages.js';
import { WorkspaceAccessSchema } from '#lib/client/ui/settings/rows.js';
import { AiModelCatalogSchema } from '#lib/client/ui/agent/agent-model-state.svelte.js';
import {
	EnvironmentStatusSchema,
	EnvoyStatusSchema,
	ManifestSchema
} from '#lib/client/ui/studio/studio-state.js';
import type { RemoteQuery, WorkspaceClientRuntime } from '#lib/client/runtime.js';

const EmptyInput = Schema.Struct({});
const AgentOpenInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentEnqueueInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	message: Schema.String,
	documents: Schema.optionalKey(Schema.Array(ChatDocumentRef))
});
const AgentLaneInput = Schema.Struct({ conversationId: Schema.NonEmptyString });
const AgentDequeueInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const AgentReorderInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	taskIds: Schema.Array(Schema.NonEmptyString)
});
const AgentDocumentBindInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	file: ChatDocumentRef
});
const AgentDocumentInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	storageKey: Schema.NonEmptyString
});
const AgentVerifierInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	verifier: Schema.Struct({ prompt: Schema.String })
});
const EnvoyInput = Schema.Struct({ envoy: Schema.NonEmptyString });
const SecretWriteInput = Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String });
const ImpersonateTeamInput = Schema.Struct({ teamId: Schema.NonEmptyString });
const AccessDecisionInput = Schema.Struct({
	action: Schema.NonEmptyString,
	resource: Schema.NonEmptyString
});
const WorkspaceAccessInput = Schema.Struct({ tenantId: Schema.NonEmptyString });

const VisibleAppsResponse = Schema.Struct({ apps: Schema.Array(Schema.String) });
const ImpersonationResponse = Schema.Struct({
	isAdmin: Schema.Boolean,
	isActive: Schema.Boolean,
	activeTeamIds: Schema.Array(Schema.String),
	teams: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
});
const AccessDecisionResponse = Schema.Struct({
	allowed: Schema.Boolean,
	reason: Schema.NonEmptyString
});
const SchemaPlanResponse = Schema.Struct({
	fingerprint: Schema.String,
	steps: Schema.Array(Schema.Struct({ id: Schema.String, sql: Schema.String }))
});

const AgentOpenResponse = Schema.Struct({
	opened: Schema.Literal(true),
	conversationId: Schema.NonEmptyString
});
const AgentDequeueResponse = Schema.Struct({ dequeued: Schema.Literal(true) });
const AgentReorderResponse = Schema.Struct({ reordered: Schema.Literal(true) });
const AgentInterruptResponse = Schema.Struct({ interrupted: Schema.Literal(true) });
const AgentStopResponse = Schema.Struct({ stopped: Schema.Literal(true) });
const AgentResumeResponse = Schema.Struct({ resumed: Schema.Literal(true) });
const AgentVerifierResponse = Schema.Struct({ updated: Schema.Literal(true) });
const AgentDocumentBindResponse = Schema.Struct({ bound: Schema.Literal(true) });
const AgentDocumentResolveResponse = Schema.Struct({ file: ChatDocumentRef });
const AgentDocumentRemoveResponse = Schema.Struct({ removed: Schema.Literal(true) });
const SecretWriteResponse = Schema.Struct({
	saved: Schema.Literal(true),
	name: Schema.NonEmptyString
});
const SchemaValidateResponse = Schema.Struct({ valid: Schema.Literal(true) });
const SchemaVerifyResponse = Schema.Struct({
	verified: Schema.Boolean,
	divergences: Schema.Array(Schema.String)
});
const SyncShapeResponse = Schema.Array(Schema.String);

type CommandInput<S extends Schema.ConstraintDecoder<unknown>> = S['Type'];
type CommandOutput<S extends Schema.ConstraintDecoder<unknown>> = S['Type'];

type SystemOperation<Input, Output> = (
	input: Input,
	signal?: AbortSignal
) => Effect.Effect<Output, unknown>;

type SystemQuery<Input, Output> = (input: Input, signal?: AbortSignal) => RemoteQuery<Output>;

type SystemQueryFactory = <
	Input extends Schema.ConstraintDecoder<Schema.Json>,
	Output extends Schema.ConstraintDecoder<Schema.Json>
>(
	command: string,
	input: Input['Type'],
	inputSchema: Input,
	outputSchema: Output,
	signal?: AbortSignal
) => RemoteQuery<Output['Type']>;

/**
 * Runtime-owned actions available on every generated workspace client.
 *
 * Collection reads and writes deliberately do not appear here: those stay on `client.db` so they
 * retain sync-engine reactivity. This namespace is only the typed action/query surface that cannot
 * be represented as a collection operation.
 */
export type SystemClientApi = Readonly<{
	agents: Readonly<{
		open: SystemOperation<
			CommandInput<typeof AgentOpenInput>,
			CommandOutput<typeof AgentOpenResponse>
		>;
		enqueue: SystemOperation<
			CommandInput<typeof AgentEnqueueInput>,
			CommandOutput<typeof AgentEnqueueResult>
		>;
		dequeue: SystemOperation<
			CommandInput<typeof AgentDequeueInput>,
			CommandOutput<typeof AgentDequeueResponse>
		>;
		reorder: SystemOperation<
			CommandInput<typeof AgentReorderInput>,
			CommandOutput<typeof AgentReorderResponse>
		>;
		interrupt: SystemOperation<
			CommandInput<typeof AgentLaneInput>,
			CommandOutput<typeof AgentInterruptResponse>
		>;
		stop: SystemOperation<
			CommandInput<typeof AgentLaneInput>,
			CommandOutput<typeof AgentStopResponse>
		>;
		resume: SystemOperation<
			CommandInput<typeof AgentLaneInput>,
			CommandOutput<typeof AgentResumeResponse>
		>;
		documents: Readonly<{
			bind: SystemOperation<
				CommandInput<typeof AgentDocumentBindInput>,
				CommandOutput<typeof AgentDocumentBindResponse>
			>;
			resolve: SystemOperation<
				CommandInput<typeof AgentDocumentInput>,
				CommandOutput<typeof AgentDocumentResolveResponse>
			>;
			remove: SystemOperation<
				CommandInput<typeof AgentDocumentInput>,
				CommandOutput<typeof AgentDocumentRemoveResponse>
			>;
		}>;
		updateVerifier: SystemOperation<
			CommandInput<typeof AgentVerifierInput>,
			CommandOutput<typeof AgentVerifierResponse>
		>;
	}>;
	ai: Readonly<{
		models: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof AiModelCatalogSchema>
		>;
	}>;
	apps: Readonly<{
		visible: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof VisibleAppsResponse>
		>;
	}>;
	access: Readonly<{
		explain: SystemQuery<
			CommandInput<typeof AccessDecisionInput>,
			CommandOutput<typeof AccessDecisionResponse>
		>;
		impersonation: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof ImpersonationResponse>
		>;
		impersonateTeam: SystemOperation<
			CommandInput<typeof ImpersonateTeamInput>,
			CommandOutput<typeof VisibleAppsResponse>
		>;
	}>;
	envoys: Readonly<{
		status: SystemQuery<CommandInput<typeof EnvoyInput>, CommandOutput<typeof EnvoyStatusSchema>>;
	}>;
	identity: Readonly<{
		workspaceAccess: SystemQuery<
			CommandInput<typeof WorkspaceAccessInput>,
			CommandOutput<typeof WorkspaceAccessSchema>
		>;
	}>;
	schema: Readonly<{
		plan: SystemQuery<CommandInput<typeof EmptyInput>, CommandOutput<typeof SchemaPlanResponse>>;
		validate: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof SchemaValidateResponse>
		>;
		verify: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof SchemaVerifyResponse>
		>;
	}>;
	secrets: Readonly<{
		status: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof EnvironmentStatusSchema>
		>;
		write: SystemOperation<
			CommandInput<typeof SecretWriteInput>,
			CommandOutput<typeof SecretWriteResponse>
		>;
	}>;
	sync: Readonly<{
		shape: SystemQuery<CommandInput<typeof EmptyInput>, CommandOutput<typeof SyncShapeResponse>>;
	}>;
	workspace: Readonly<{
		manifest: SystemQuery<CommandInput<typeof EmptyInput>, CommandOutput<typeof ManifestSchema>>;
		authoringManifest: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof ManifestSchema>
		>;
	}>;
}>;

const command =
	<
		Input extends Schema.ConstraintDecoder<unknown>,
		Output extends Schema.ConstraintDecoder<unknown>
	>(
		runtime: WorkspaceClientRuntime,
		name: string,
		inputSchema: Input,
		outputSchema: Output
	): SystemOperation<CommandInput<Input>, CommandOutput<Output>> =>
	(input, signal) =>
		Effect.gen(function* () {
			const checked = yield* Schema.decodeUnknownEffect(inputSchema)(input);
			const payload = yield* Schema.decodeUnknownEffect(Schema.Json)(checked);
			return yield* Effect.tryPromise(() =>
				runtime.bolt.command(name, payload, outputSchema, signal)
			);
		});

const query =
	<
		Input extends Schema.ConstraintDecoder<Schema.Json>,
		Output extends Schema.ConstraintDecoder<Schema.Json>
	>(
		make: SystemQueryFactory,
		name: string,
		inputSchema: Input,
		outputSchema: Output
	): SystemQuery<CommandInput<Input>, CommandOutput<Output>> =>
	(input, signal) =>
		make(name, input, inputSchema, outputSchema, signal);

/** Builds the typed system namespace attached to every generated workspace client. */
export const createSystemClient = (
	runtime: WorkspaceClientRuntime,
	makeQuery: SystemQueryFactory
): SystemClientApi => ({
	agents: {
		open: command(runtime, 'agents.open', AgentOpenInput, AgentOpenResponse),
		enqueue: command(runtime, 'agents.enqueue', AgentEnqueueInput, AgentEnqueueResult),
		dequeue: command(runtime, 'agents.dequeue', AgentDequeueInput, AgentDequeueResponse),
		reorder: command(runtime, 'agents.reorder', AgentReorderInput, AgentReorderResponse),
		interrupt: command(runtime, 'agents.interrupt', AgentLaneInput, AgentInterruptResponse),
		stop: command(runtime, 'agents.stop', AgentLaneInput, AgentStopResponse),
		resume: command(runtime, 'agents.resume', AgentLaneInput, AgentResumeResponse),
		documents: {
			bind: command(
				runtime,
				'agents.documents.bind',
				AgentDocumentBindInput,
				AgentDocumentBindResponse
			),
			resolve: command(
				runtime,
				'agents.documents.resolve',
				AgentDocumentInput,
				AgentDocumentResolveResponse
			),
			remove: command(
				runtime,
				'agents.documents.remove',
				AgentDocumentInput,
				AgentDocumentRemoveResponse
			)
		},
		updateVerifier: command(
			runtime,
			'agents.updateVerifier',
			AgentVerifierInput,
			AgentVerifierResponse
		)
	},
	ai: { models: query(makeQuery, 'ai.models', EmptyInput, AiModelCatalogSchema) },
	apps: { visible: query(makeQuery, 'apps.visible', EmptyInput, VisibleAppsResponse) },
	access: {
		explain: query(makeQuery, 'access.explain', AccessDecisionInput, AccessDecisionResponse),
		impersonation: query(makeQuery, 'access.impersonation', EmptyInput, ImpersonationResponse),
		impersonateTeam: command(
			runtime,
			'access.impersonateTeam',
			ImpersonateTeamInput,
			VisibleAppsResponse
		)
	},
	envoys: { status: query(makeQuery, 'envoys.status', EnvoyInput, EnvoyStatusSchema) },
	identity: {
		workspaceAccess: query(
			makeQuery,
			'identity.workspaceAccess',
			WorkspaceAccessInput,
			WorkspaceAccessSchema
		)
	},
	schema: {
		plan: query(makeQuery, 'schema.plan', EmptyInput, SchemaPlanResponse),
		validate: query(makeQuery, 'schema.validate', EmptyInput, SchemaValidateResponse),
		verify: query(makeQuery, 'schema.verify', EmptyInput, SchemaVerifyResponse)
	},
	secrets: {
		status: query(makeQuery, 'secrets.status', EmptyInput, EnvironmentStatusSchema),
		write: command(runtime, 'secrets.write', SecretWriteInput, SecretWriteResponse)
	},
	sync: { shape: query(makeQuery, 'sync.shape', EmptyInput, SyncShapeResponse) },
	workspace: {
		manifest: query(makeQuery, 'workspace.manifest', EmptyInput, ManifestSchema),
		authoringManifest: query(makeQuery, 'workspace.authoringManifest', EmptyInput, ManifestSchema)
	}
});
