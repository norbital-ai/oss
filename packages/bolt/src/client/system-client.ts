import { Effect, Schema } from 'effect';
import { TurnResult } from '#lib/runtime/agents/agent-schemas.js';
import { WorkspaceAccessSchema } from '#lib/client/ui/settings/rows.js';
import { AiModelCatalogSchema } from '#lib/client/ui/agent/agent-model-state.svelte.js';
import {
	EnvironmentStatusSchema,
	EnvoyStatusSchema,
	ManifestSchema
} from '#lib/client/ui/studio/studio-state.js';
import type { RemoteQuery, WorkspaceClientRuntime } from '#lib/client/runtime.js';

const EmptyInput = Schema.Struct({});
const AgentStartInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentTurnInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	message: Schema.String
});
const AgentVerifierInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	verifier: Schema.Struct({ prompt: Schema.String })
});
const AutomationHistoryInput = Schema.Struct({
	name: Schema.NonEmptyString,
	limit: Schema.Number
});
const AutomationStartInput = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.Json
});
const TaskInput = Schema.Struct({ taskId: Schema.NonEmptyString });
const EnvoyInput = Schema.Struct({ envoy: Schema.NonEmptyString });
const SecretWriteInput = Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String });
const ImpersonateTeamInput = Schema.Struct({ teamId: Schema.NonEmptyString });
const WorkspaceAccessInput = Schema.Struct({ tenantId: Schema.NonEmptyString });

const VisibleAppsResponse = Schema.Struct({ apps: Schema.Array(Schema.String) });
const ImpersonationResponse = Schema.Struct({
	isAdmin: Schema.Boolean,
	isActive: Schema.Boolean,
	activeTeamIds: Schema.Array(Schema.String),
	teams: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
});
export const SchemaPlanResponse = Schema.Struct({
	fingerprint: Schema.String,
	steps: Schema.Array(Schema.Struct({ id: Schema.String, sql: Schema.String }))
});
export const AutomationHistoryRow = Schema.Struct({
	effect_id: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
	attempts: Schema.optionalKey(Schema.Number),
	error: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.String)
});
const AutomationHistoryResponse = Schema.Struct({
	runs: Schema.optionalKey(Schema.Array(AutomationHistoryRow))
});
const AutomationStartResponse = Schema.Struct({
	taskId: Schema.optionalKey(Schema.String)
});
const AutomationStatusResponse = Schema.NullOr(
	Schema.Struct({
		status: Schema.optionalKey(Schema.String),
		error: Schema.optionalKey(Schema.String)
	})
);

const AgentStartResponse = Schema.Struct({
	started: Schema.Literal(true),
	conversationId: Schema.NonEmptyString
});
const AgentVerifierResponse = Schema.Struct({ updated: Schema.Literal(true) });
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
		start: SystemOperation<
			CommandInput<typeof AgentStartInput>,
			CommandOutput<typeof AgentStartResponse>
		>;
		turn: SystemOperation<CommandInput<typeof AgentTurnInput>, CommandOutput<typeof TurnResult>>;
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
		impersonation: SystemQuery<
			CommandInput<typeof EmptyInput>,
			CommandOutput<typeof ImpersonationResponse>
		>;
		impersonateTeam: SystemOperation<
			CommandInput<typeof ImpersonateTeamInput>,
			CommandOutput<typeof VisibleAppsResponse>
		>;
	}>;
	automations: Readonly<{
		history: SystemQuery<
			CommandInput<typeof AutomationHistoryInput>,
			CommandOutput<typeof AutomationHistoryResponse>
		>;
		start: SystemOperation<
			CommandInput<typeof AutomationStartInput>,
			CommandOutput<typeof AutomationStartResponse>
		>;
		status: SystemQuery<
			CommandInput<typeof TaskInput>,
			CommandOutput<typeof AutomationStatusResponse>
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
		start: command(runtime, 'agents.start', AgentStartInput, AgentStartResponse),
		turn: command(runtime, 'agents.turn', AgentTurnInput, TurnResult),
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
		impersonation: query(makeQuery, 'access.impersonation', EmptyInput, ImpersonationResponse),
		impersonateTeam: command(
			runtime,
			'access.impersonateTeam',
			ImpersonateTeamInput,
			VisibleAppsResponse
		)
	},
	automations: {
		history: query(
			makeQuery,
			'automations.history',
			AutomationHistoryInput,
			AutomationHistoryResponse
		),
		start: command(runtime, 'automations.start', AutomationStartInput, AutomationStartResponse),
		status: query(makeQuery, 'automations.status', TaskInput, AutomationStatusResponse)
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
	workspace: { manifest: query(makeQuery, 'workspace.manifest', EmptyInput, ManifestSchema) }
});
