/// <reference types="node" />
// The kernel ports of a same-graph host (bolt-server, `bolt dev`, the test kit): every Node dependency the engine had,
// served from this process. A kernel hosting cells serves its own, reusing these pieces.
import { Effect } from 'effect';
import type {
	ArtifactPort,
	DocsPort,
	HttpPort,
	ImagesPort,
	KeysPort,
	McpPort
} from '../engine/contracts.ts';
import type { TenantDbShape } from '../engine/db/tenant-db.ts';
import type { HostTenantDb } from '../protocol/host-api.ts';
import { artifact_port } from './artifact.ts';
import { docs_port } from './docs.ts';
import { tenant_db_port } from './db/port.ts';
import { images_port } from './images.ts';
import { keys_port } from './keys.ts';
import { mcp_port } from './mcp.ts';
import { http_port } from './net.ts';

export type NodePortsOptions = {
	/** The release directory; its seed packs are `../seed/<pack>`. Without one there is no artifact port. */
	readonly release?: string | undefined;
	/** The tenant's 32-byte secrets key; without one nothing seals or opens. */
	readonly secrets_key?: Uint8Array | undefined;
	/** The environment's database, as `HOST_API` takes it. */
	readonly database?: TenantDbShape | undefined;
};
export type NodePorts = {
	readonly artifact?: ArtifactPort;
	readonly keys?: KeysPort;
	readonly database?: HostTenantDb;
	readonly http: HttpPort;
	readonly images: ImagesPort;
	readonly mcp: McpPort;
	readonly docs: DocsPort;
};

/** The ports, alive until the scope closes: MCP sessions end with it. */
export const node_ports = Effect.fn('node.ports')(function* (options: NodePortsOptions = {}) {
	const ports: NodePorts = {
		...(options.release === undefined ? {} : { artifact: artifact_port(options.release) }),
		...(options.secrets_key === undefined ? {} : { keys: keys_port(options.secrets_key) }),
		...(options.database === undefined ? {} : { database: tenant_db_port(options.database) }),
		http: http_port,
		images: images_port,
		mcp: yield* mcp_port,
		docs: docs_port()
	};
	return ports;
});
