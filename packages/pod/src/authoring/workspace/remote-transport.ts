import type { RemoteQuery } from '$lib/ui/state/remote-query.svelte.js';
import type { RemoteDbTransport } from './db-api-types.js';
import type { PodRemoteOperations } from './pod-remote-operations.js';

type InvokeTransportInput = {
	readonly name: string;
	readonly payload: unknown;
};

export type WorkspaceRemoteTransport = {
	readonly db: RemoteDbTransport;
	readonly invokeCommand: (input: InvokeTransportInput) => Promise<unknown>;
	readonly invokeQuery: (input: InvokeTransportInput) => RemoteQuery<unknown>;
	readonly exportPipeline: PodRemoteOperations['exportPipeline'];
	readonly importPipeline: PodRemoteOperations['importPipeline'];
	readonly agentChat?: PodRemoteOperations['agentChat'];
	readonly agentChatStart: PodRemoteOperations['agentChatStart'];
	readonly agentChatUpdateVerifier: PodRemoteOperations['agentChatUpdateVerifier'];
	readonly agentModels: PodRemoteOperations['agentModels'];
	readonly autocompleteGeolocation: PodRemoteOperations['autocompleteGeolocation'];
	readonly renderStaticMap: PodRemoteOperations['renderStaticMap'];
	readonly processApprovalRequestAction: NonNullable<
		PodRemoteOperations['processApprovalRequestAction']
	>;
	readonly withdrawApprovalRequest: NonNullable<PodRemoteOperations['withdrawApprovalRequest']>;
};

let workspaceRemoteTransport: WorkspaceRemoteTransport | undefined;

export function setWorkspaceRemoteTransport(transport: WorkspaceRemoteTransport): void {
	workspaceRemoteTransport = transport;
}

export function getWorkspaceRemoteTransport(): WorkspaceRemoteTransport {
	if (!workspaceRemoteTransport) {
		throw new Error('Workspace remote transport not registered');
	}
	return workspaceRemoteTransport;
}
