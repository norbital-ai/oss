import { Effect, Schema } from 'effect';
import type { Prompt } from 'effect/unstable/ai';
import {
	ConversationControlRequest,
	type ConversationControlResult,
	ConversationEditMessageRequest,
	type ConversationEditMessageResult,
	ConversationSendRequest,
	type ConversationSendResult
} from '@norbital-ai/bolt-protocol';
import { getErrorMessage } from '@norbital-ai/std';
import { getContext, setContext } from 'svelte';
import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import { COMPOSER_COMMAND_DEADLINE_MILLIS } from './composer-send.js';

type TaskSubmissionInput = Readonly<{
	readonly conversationId?: string;
	readonly submissionId?: string;
	readonly message: Prompt.MessageEncoded;
	readonly mode: ConversationSendRequest['mode'];
	readonly priority?: ConversationSendRequest['priority'];
	readonly modelId?: string;
}>;

type TaskSubmission = Readonly<{
	readonly conversationId: ConversationSendRequest['conversationId'];
	readonly messageId: ConversationSendResult['messageId'];
}>;

type TaskRevisionInput = Readonly<{
	readonly conversationId: string;
	readonly messageId: string;
	readonly message: Prompt.MessageEncoded;
	readonly modelId?: string;
}>;

type TaskRevision = Readonly<{
	readonly conversationId: ConversationEditMessageRequest['conversationId'];

	readonly messageId: ConversationEditMessageResult['messageId'];
	readonly supersedesId: ConversationEditMessageResult['supersedesId'];
}>;

class AgentClientFailure extends Schema.TaggedError<AgentClientFailure>()(
	'Bolt.AgentClientFailure',
	{ operation: Schema.NonEmptyString, message: Schema.String, cause: Schema.Defect() }
) {}

const agentRequest = <A, E>(operation: string, request: Effect.Effect<A, E>) =>
	request.pipe(
		Effect.mapError(
			(cause) =>
				new AgentClientFailure({
					operation,
					message: getErrorMessage(cause),
					cause
				})
		)
	);

/** Runtime capabilities shared by the workspace shell and its Task surfaces. */
export type TurntimeConfig = Readonly<{
	readonly client: WorkspaceClient;
	readonly subject: Subject;
	readonly agentId: string;
}>;

type AgentSurface = {
	conversationId: string | undefined;
	composingNew: boolean;
	pending: boolean;
	failed: boolean;
};

type AgentClient = Readonly<{
	runtime: TurntimeConfig;
	surface: AgentSurface;
	writeSurface: (next: AgentSurface) => void;
	submit: (input: TaskSubmissionInput) => Effect.Effect<TaskSubmission, AgentClientFailure>;
	editMessage: (input: TaskRevisionInput) => Effect.Effect<TaskRevision, AgentClientFailure>;
	control: (
		conversationId: string,
		action: ConversationControlRequest['action'],
		modelId?: string
	) => Effect.Effect<ConversationControlResult, AgentClientFailure>;
}>;

const AGENT_CLIENT_CONTEXT = Symbol('norbital.agent-client');

/**
 * Submits one canonical Effect message. The client-minted submission ID distinguishes a send from its retries;
 * durable reads remain ordinary Live Query collection reads.
 */
function submitTask(
	active: TurntimeConfig,
	input: TaskSubmissionInput,
	randomId: () => string = () => globalThis.crypto.randomUUID()
): Effect.Effect<TaskSubmission, AgentClientFailure> {
	const conversationId = input.conversationId ?? randomId();
	return agentRequest(
		'conversations.send',
		Schema.decodeUnknownEffect(ConversationSendRequest)({
			conversationId,
			submissionId: input.submissionId ?? randomId(),
			agentId: active.agentId,
			message: input.message,
			mode: input.mode,
			priority: input.priority ?? 'normal',
			...(input.modelId === undefined ? {} : { modelId: input.modelId })
		}).pipe(
			Effect.flatMap((request) =>
				active.client.system.conversations
					.send(request, AbortSignal.timeout(COMPOSER_COMMAND_DEADLINE_MILLIS))
					.pipe(
						Effect.map((result) => ({ conversationId: request.conversationId, messageId: result.messageId }))
					)
			)
		)
	);
}

function editTask(
	active: TurntimeConfig,
	input: TaskRevisionInput
): Effect.Effect<TaskRevision, AgentClientFailure> {
	return agentRequest(
		'conversations.editMessage',
		Schema.decodeUnknownEffect(ConversationEditMessageRequest)({
			conversationId: input.conversationId,
			messageId: input.messageId,
			message: input.message,
			...(input.modelId === undefined ? {} : { modelId: input.modelId })
		}).pipe(
			Effect.flatMap((request) =>
				active.client.system.conversations
					.editMessage(request, AbortSignal.timeout(COMPOSER_COMMAND_DEADLINE_MILLIS))
					.pipe(
						Effect.map((result) => ({
							conversationId: request.conversationId,
							messageId: result.messageId,
							supersedesId: result.supersedesId
						}))
					)
			)
		)
	);
}

function controlConversation(
	active: TurntimeConfig,
	conversationId: string,
	action: ConversationControlRequest['action'],
	modelId?: string
): Effect.Effect<ConversationControlResult, AgentClientFailure> {
	return agentRequest(
		'conversations.control',
		Schema.decodeUnknownEffect(ConversationControlRequest)({
			conversationId,
			action,
			...(modelId === undefined || action === 'stop' ? {} : { modelId })
		}).pipe(
			Effect.flatMap((request) =>
				active.client.system.conversations.control(
					request,
					AbortSignal.timeout(COMPOSER_COMMAND_DEADLINE_MILLIS)
				)
			)
		)
	);
}

/** Builds one mounted workspace's Task state and actions. */
export function createAgentClient(runtime: TurntimeConfig): AgentClient {
	const surface = $state<AgentSurface>({
		conversationId: undefined,
		composingNew: false,
		pending: false,
		failed: false
	});
	return {
		runtime,
		surface,
		writeSurface: (next) => {
			surface.conversationId = next.conversationId;
			surface.composingNew = next.composingNew;
			surface.pending = next.pending;
			surface.failed = next.failed;
		},
		submit: (input) => submitTask(runtime, input),
		editMessage: (input) => editTask(runtime, input),
		control: (conversationId, action, modelId) => controlConversation(runtime, conversationId, action, modelId)
	};
}

/** Publishes one workspace-owned Task client to descendant surfaces. */
export function provideAgentClient(runtime: TurntimeConfig): AgentClient {
	const client = createAgentClient(runtime);
	setContext(AGENT_CLIENT_CONTEXT, client);
	return client;
}

/** Reads the Task client belonging to the current workspace component tree. */
export function useAgentClient(): AgentClient {
	const client = getContext<AgentClient | undefined>(AGENT_CLIENT_CONTEXT);
	if (client === undefined) throw new Error('Agent client is unavailable outside a workspace');
	return client;
}
