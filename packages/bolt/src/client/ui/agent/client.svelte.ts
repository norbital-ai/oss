import { Effect, Schema } from 'effect';
import { getContext, setContext } from 'svelte';
import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import {
	createAgentModelController,
	type AgentModelController,
	type WorkspaceRemoteTransport
} from './agent-model-state.svelte.js';

type InteractiveAgentStartInput = {
	readonly message: string;
	readonly runId?: string;
	readonly planMode?: boolean;
	readonly intent?: 'do' | 'plan';
	readonly verifierPrompt?: string;
	readonly model?: string;
	readonly mentions?: readonly {
		readonly collection: string;
		readonly recordId: string;
		readonly label: string;
	}[];
};

type AgentChatStartResult = { readonly runId: string; readonly chatId: string };

class AgentClientFailure extends Schema.TaggedError<AgentClientFailure>()(
	'Bolt.AgentClientFailure',
	{ operation: Schema.NonEmptyString, cause: Schema.Defect() }
) {}

const agentRequest = <A>(operation: string, request: Effect.Effect<A, unknown>) =>
	request.pipe(Effect.mapError((cause) => new AgentClientFailure({ operation, cause })));

/**
 * Runtime capabilities shared by the workspace shell and its agent surfaces.
 *
 * The client is the generated workspace client itself. Its platform collections use the same
 * reactive sync query path as authored collections; no agent-specific read adapter sits beside it.
 */
export type AgentRuntimeConfig = Readonly<{
	readonly client: Readonly<{
		readonly db: Pick<
			WorkspaceClient['db'],
			'approval_request' | 'chat_session' | 'chat_message' | 'user' | 'bolt_notifications'
		>;
		readonly records: WorkspaceClient['records'];
		readonly system: WorkspaceClient['system'];
	}>;
	readonly subject: Subject;
	readonly agentName: string;
}>;

type AgentSurface = {
	chatId: string | undefined;
	composingNew: boolean;
	pending: boolean;
	failed: boolean;
};

type AgentClient = Readonly<{
	runtime: AgentRuntimeConfig;
	surface: AgentSurface;
	models: AgentModelController;
	catalog: {
		collections: readonly string[];
		apps: readonly {
			readonly key: string;
			readonly label: string;
			readonly href?: string;
			readonly description?: string | null;
		}[];
	};
	writeSurface: (next: AgentSurface) => void;
	start: (
		input: InteractiveAgentStartInput
	) => Effect.Effect<AgentChatStartResult, AgentClientFailure>;
	updateVerifier: (input: {
		readonly runId: string;
		readonly prompt: string;
	}) => Effect.Effect<{ readonly accepted: true }, AgentClientFailure>;
}>;

const AGENT_CLIENT_CONTEXT = Symbol('norbital.agent-client');

/** Starts or continues one conversation. Reads remain owned by the reactive sync client. */

function startInteractiveAgent(
	active: AgentRuntimeConfig,
	input: InteractiveAgentStartInput
): Effect.Effect<AgentChatStartResult, AgentClientFailure> {
	const conversationId = input.runId ?? crypto.randomUUID();
	return Effect.gen(function* () {
		yield* agentRequest(
			'start',
			active.client.system.agents.start({
				agent: active.agentName,
				conversationId
			})
		);
		Effect.runFork(
			agentRequest(
				'turn',
				active.client.system.agents.turn({
					agent: active.agentName,
					conversationId,
					message: input.message
				})
			).pipe(
				Effect.catch((failure) =>
					Effect.logError('Agent turn transport failed after the conversation was started', failure)
				)
			)
		);
		return { runId: conversationId, chatId: conversationId };
	});
}

function updateAgentVerifier(
	active: AgentRuntimeConfig,
	input: {
		readonly runId: string;
		readonly prompt: string;
	}
): Effect.Effect<{ readonly accepted: true }, AgentClientFailure> {
	return Effect.gen(function* () {
		yield* agentRequest(
			'updateVerifier',
			active.client.system.agents.updateVerifier({
				conversationId: input.runId,
				verifier: { prompt: input.prompt }
			})
		);
		return { accepted: true };
	});
}

/** Builds one mounted workspace's agent state and actions. */
export function createAgentClient(
	runtime: AgentRuntimeConfig,
	modelTransport: WorkspaceRemoteTransport
): AgentClient {
	const surface = $state<AgentSurface>({
		chatId: undefined,
		composingNew: false,
		pending: false,
		failed: false
	});
	const catalog = $state<AgentClient['catalog']>({ collections: [], apps: [] });
	return {
		runtime,
		surface,
		models: createAgentModelController(modelTransport),
		catalog,
		writeSurface: (next) => {
			surface.chatId = next.chatId;
			surface.composingNew = next.composingNew;
			surface.pending = next.pending;
			surface.failed = next.failed;
		},
		start: (input) => startInteractiveAgent(runtime, input),
		updateVerifier: (input) => updateAgentVerifier(runtime, input)
	};
}

/** Publishes one workspace-owned agent client to descendant surfaces. */
export function provideAgentClient(
	runtime: AgentRuntimeConfig,
	modelTransport: WorkspaceRemoteTransport
): AgentClient {
	const client = createAgentClient(runtime, modelTransport);
	setContext(AGENT_CLIENT_CONTEXT, client);
	return client;
}

/** Reads the agent client belonging to the current workspace component tree. */
export function useAgentClient(): AgentClient {
	const client = getContext<AgentClient | undefined>(AGENT_CLIENT_CONTEXT);
	if (client === undefined) throw new Error('Agent client is unavailable outside a workspace');
	return client;
}
