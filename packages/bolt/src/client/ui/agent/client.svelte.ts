import { Effect, Schema } from 'effect';
import type { Prompt } from 'effect/unstable/ai';
import {
	TaskControlRequest,
	type TaskControlResult,
	TaskEditMessageRequest,
	type TaskEditMessageResult,
	TaskSubmitRequest,
	type TaskSubmitResult
} from '@norbital-ai/bolt-protocol';
import { getErrorMessage } from '@norbital-ai/std';
import { getContext, setContext } from 'svelte';
import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
import type { Subject } from '#lib/runtime/identity/identity.js';

type TaskSubmissionInput = Readonly<{
	readonly taskId?: string;
	readonly message: Prompt.MessageEncoded;
	readonly mode: TaskSubmitRequest['mode'];
	readonly priority?: TaskSubmitRequest['priority'];
}>;

type TaskSubmission = Readonly<{
	readonly taskId: TaskSubmitRequest['taskId'];
	readonly directiveId: TaskSubmitResult['directiveId'];
}>;

type TaskRevisionInput = Readonly<{
	readonly taskId: string;
	readonly messageId: string;
	readonly message: Prompt.MessageEncoded;
}>;

type TaskRevision = Readonly<{
	readonly taskId: TaskEditMessageRequest['taskId'];
	readonly directiveId: TaskEditMessageResult['directiveId'];
	readonly messageId: TaskEditMessageResult['messageId'];
	readonly supersedesId: TaskEditMessageResult['supersedesId'];
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
export type AgentRuntimeConfig = Readonly<{
	readonly client: WorkspaceClient;
	readonly subject: Subject;
	readonly agentId: string;
}>;

type AgentSurface = {
	taskId: string | undefined;
	composingNew: boolean;
	pending: boolean;
	failed: boolean;
};

type AgentClient = Readonly<{
	runtime: AgentRuntimeConfig;
	surface: AgentSurface;
	writeSurface: (next: AgentSurface) => void;
	submit: (input: TaskSubmissionInput) => Effect.Effect<TaskSubmission, AgentClientFailure>;
	editMessage: (input: TaskRevisionInput) => Effect.Effect<TaskRevision, AgentClientFailure>;
	control: (
		taskId: string,
		action: TaskControlRequest['action']
	) => Effect.Effect<TaskControlResult, AgentClientFailure>;
}>;

const AGENT_CLIENT_CONTEXT = Symbol('norbital.agent-client');

/**
 * Submits one canonical Effect message. The client-minted Task ID is the admission idempotency key;
 * durable reads remain ordinary Live Query collection reads.
 */
function submitTask(
	active: AgentRuntimeConfig,
	input: TaskSubmissionInput,
	randomId: () => string = () => globalThis.crypto.randomUUID()
): Effect.Effect<TaskSubmission, AgentClientFailure> {
	const taskId = input.taskId ?? randomId();
	return agentRequest(
		'tasks.submit',
		Schema.decodeUnknownEffect(TaskSubmitRequest)({
			taskId,
			agentId: active.agentId,
			message: input.message,
			mode: input.mode,
			priority: input.priority ?? 'normal'
		}).pipe(
			Effect.flatMap((request) =>
				active.client.system.tasks
					.submit(request)
					.pipe(
						Effect.map((result) => ({ taskId: request.taskId, directiveId: result.directiveId }))
					)
			)
		)
	);
}

function editTask(
	active: AgentRuntimeConfig,
	input: TaskRevisionInput
): Effect.Effect<TaskRevision, AgentClientFailure> {
	return agentRequest(
		'tasks.editMessage',
		Schema.decodeUnknownEffect(TaskEditMessageRequest)({
			taskId: input.taskId,
			messageId: input.messageId,
			message: input.message
		}).pipe(
			Effect.flatMap((request) =>
				active.client.system.tasks
					.editMessage(request)
					.pipe(
						Effect.map((result) => ({
							taskId: request.taskId,
							directiveId: result.directiveId,
							messageId: result.messageId,
							supersedesId: result.supersedesId
						}))
					)
			)
		)
	);
}

function controlTask(
	active: AgentRuntimeConfig,
	taskId: string,
	action: TaskControlRequest['action']
): Effect.Effect<TaskControlResult, AgentClientFailure> {
	return agentRequest(
		'tasks.control',
		Schema.decodeUnknownEffect(TaskControlRequest)({ taskId, action }).pipe(
			Effect.flatMap((request) => active.client.system.tasks.control(request))
		)
	);
}

/** Builds one mounted workspace's Task state and actions. */
export function createAgentClient(runtime: AgentRuntimeConfig): AgentClient {
	const surface = $state<AgentSurface>({
		taskId: undefined,
		composingNew: false,
		pending: false,
		failed: false
	});
	return {
		runtime,
		surface,
		writeSurface: (next) => {
			surface.taskId = next.taskId;
			surface.composingNew = next.composingNew;
			surface.pending = next.pending;
			surface.failed = next.failed;
		},
		submit: (input) => submitTask(runtime, input),
		editMessage: (input) => editTask(runtime, input),
		control: (taskId, action) => controlTask(runtime, taskId, action)
	};
}

/** Publishes one workspace-owned Task client to descendant surfaces. */
export function provideAgentClient(runtime: AgentRuntimeConfig): AgentClient {
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
