import { Effect, Schema } from 'effect';
import { AgentEnqueueResult, ChatDocumentRef } from '@norbital-ai/bolt-protocol';
import { WorkspaceAccessSchema } from '#lib/client/ui/settings/rows.js';
import { AiModelCatalogSchema } from '#lib/client/ui/agent/agent-model-state.svelte.js';
import {
	EnvironmentStatusSchema,
	EnvoyStatusSchema,
	ManifestSchema
} from '#lib/client/ui/studio/studio-state.js';
import type { RemoteQuery, WorkspaceClientRuntime } from '#lib/client/contracts.js';
import { stableKey } from '#lib/client/live-query/stable-key.js';

const EmptyInput = Schema.Struct({});
const AgentOpenInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentEnqueueInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString,
	message: Schema.String,
	documents: Schema.optionalKey(Schema.Array(ChatDocumentRef)),
	mode: Schema.optionalKey(Schema.Literals(['queue', 'steer'])),
	intent: Schema.optionalKey(Schema.Literals(['do', 'plan', 'compact'])),
	verifierPrompt: Schema.optionalKey(Schema.NonEmptyString),
	/** Caller-selected host model; absent means the catalog default. */
	model: Schema.optionalKey(Schema.NonEmptyString)
});
const AgentLaneInput = Schema.Struct({ conversationId: Schema.NonEmptyString });
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
const AgentStopResponse = Schema.Struct({ stopped: Schema.Literal(true) });
const AgentResumeResponse = Schema.Struct({ resumed: Schema.Literal(true) });
const AgentVerifierResponse = Schema.Struct({ updated: Schema.Literal(true) });
const AgentDocumentAttachResponse = Schema.Struct({ attached: Schema.Literal(true) });
const AgentDocumentReadResponse = Schema.Struct({
	file: ChatDocumentRef,
	bytesBase64: Schema.NonEmptyString
});
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
		stop: SystemOperation<
			CommandInput<typeof AgentLaneInput>,
			CommandOutput<typeof AgentStopResponse>
		>;
		resume: SystemOperation<
			CommandInput<typeof AgentLaneInput>,
			CommandOutput<typeof AgentResumeResponse>
		>;
		documents: Readonly<{
			attach: SystemOperation<
				CommandInput<typeof AgentDocumentBindInput>,
				CommandOutput<typeof AgentDocumentAttachResponse>
			>;
			read: SystemOperation<
				CommandInput<typeof AgentDocumentInput>,
				CommandOutput<typeof AgentDocumentReadResponse>
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

/** One release-owned query object per semantic input for the lifetime of its workspace client. */
const memoizedQuery = <
	Input extends Schema.ConstraintDecoder<Schema.Json>,
	Output extends Schema.ConstraintDecoder<Schema.Json>
>(
	make: SystemQueryFactory,
	name: string,
	inputSchema: Input,
	outputSchema: Output
): SystemQuery<CommandInput<Input>, CommandOutput<Output>> => {
	const held = new Map<string, RemoteQuery<CommandOutput<Output>>>();
	return (input, signal) => {
		if (signal !== undefined) return make(name, input, inputSchema, outputSchema, signal);
		const key = stableKey(input);
		const existing = held.get(key);
		if (existing !== undefined) return existing;
		const created = make(name, input, inputSchema, outputSchema);
		held.set(key, created);
		return created;
	};
};

/** Builds the typed system namespace attached to every generated workspace client. */
export const createSystemClient = (
	runtime: WorkspaceClientRuntime,
	makeQuery: SystemQueryFactory
): SystemClientApi => ({
	agents: {
		open: command(runtime, 'agents.open', AgentOpenInput, AgentOpenResponse),
		enqueue: command(runtime, 'agents.enqueue', AgentEnqueueInput, AgentEnqueueResult),
		stop: command(runtime, 'agents.stop', AgentLaneInput, AgentStopResponse),
		resume: command(runtime, 'agents.resume', AgentLaneInput, AgentResumeResponse),
		documents: {
			attach: command(
				runtime,
				'agents.documents.attach',
				AgentDocumentBindInput,
				AgentDocumentAttachResponse
			),
			read: command(
				runtime,
				'agents.documents.read',
				AgentDocumentInput,
				AgentDocumentReadResponse
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
	workspace: {
		manifest: memoizedQuery(makeQuery, 'workspace.manifest', EmptyInput, ManifestSchema),
		authoringManifest: memoizedQuery(
			makeQuery,
			'workspace.authoringManifest',
			EmptyInput,
			ManifestSchema
		)
	}
});
