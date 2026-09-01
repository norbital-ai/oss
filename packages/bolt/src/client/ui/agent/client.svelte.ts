import { Effect, Schema } from 'effect';
import type { Prompt } from 'effect/unstable/ai';
import {
	TaskControlRequest,
	type TaskControlResult,
	TaskSubmitRequest,
	type TaskSubmitResult
} from '@norbital-ai/bolt-protocol';
import { getContext, setContext } from 'svelte';
import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
import type { Subject } from '#lib/runtime/identity/identity.js';

export type TaskSubmissionInput = Readonly<{
	readonly taskId?: string;
	readonly message: Prompt.MessageEncoded;
	readonly mode: TaskSubmitRequest['mode'];
	readonly priority?: TaskSubmitRequest['priority'];
}>;

export type TaskSubmission = Readonly<{
	readonly taskId: TaskSubmitRequest['taskId'];
	readonly directiveId: TaskSubmitResult['directiveId'];
}>;

class AgentClientFailure extends Schema.TaggedError<AgentClientFailure>()(
	'Bolt.AgentClientFailure',
	{ operation: Schema.NonEmptyString, message: Schema.String, cause: Schema.Defect() }
) {}

const agentRequest = <A>(operation: string, request: Effect.Effect<A, unknown>) =>
	request.pipe(
		Effect.mapError(
			(cause) =>
				new AgentClientFailure({
					operation,
					message: cause instanceof Error ? cause.message : String(cause),
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
