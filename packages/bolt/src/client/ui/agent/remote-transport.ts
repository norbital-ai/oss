import type { AiModelCatalog } from './models.js';

export type WorkspaceRemoteTransport = {
	agentModels(): Promise<AiModelCatalog | null>;
};

let transport: WorkspaceRemoteTransport | undefined;

export function setWorkspaceRemoteTransport(next: WorkspaceRemoteTransport | undefined): void {
	transport = next;
}

export function getWorkspaceRemoteTransport(): WorkspaceRemoteTransport {
	return transport ?? { agentModels: async () => null };
}
