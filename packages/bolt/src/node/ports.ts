/// <reference types="node" />
// The kernel ports of a same-graph host (`bolt dev`, the test kit): every Node dependency the engine had,
// served from this process. A kernel hosting cells serves its own, reusing these pieces.
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import type {
	ArtifactPort,
	HostTenantDb,
	HttpPort,
	ImagesPort,
	KeysPort,
	McpPort
} from '@norbital-ai/host-api';
import type { TenantDbShape } from '../engine/db/tenant-db.ts';
import {
	artifact_port,
	http_port,
	images_port,
	keys_port,
	mcp_port,
	tenant_db_port
} from '@norbital-ai/host-api/node';
import { DOCS_DIR } from './docs.ts';

type NodePortsOptions = {
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
};

/** The ports, alive until the scope closes: MCP sessions end with it. */
export const node_ports = Effect.fn('node.ports')(function* (options: NodePortsOptions = {}) {
	const ports: NodePorts = {
		...(options.release === undefined ? {} : { artifact: artifact_port(options.release, fileURLToPath(DOCS_DIR)) }),
		...(options.secrets_key === undefined ? {} : { keys: keys_port(options.secrets_key) }),
		...(options.database === undefined ? {} : { database: tenant_db_port(options.database) }),
		http: http_port,
		images: images_port,
		mcp: yield* mcp_port
	};
	return ports;
});
