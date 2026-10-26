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
import { artifactPort } from './artifact.ts';
import { docsPort } from './docs.ts';
import { tenantDbPort } from './db/port.ts';
import {
	guestIsolates,
	type GuestIsolatesOptions,
	type NodeGuestIsolates
} from './guest-isolates.ts';
import { imagesPort } from './images.ts';
import { keysPort } from './keys.ts';
import { mcpPort } from './mcp.ts';
import { httpPort } from './net.ts';

export type NodePortsOptions = {
	/** The release directory; its seed packs are `../seed/<pack>`. Without one there is no artifact port. */
	readonly release?: string | undefined;
	/** The tenant's 32-byte secrets key; without one nothing seals or opens. */
	readonly secretsKey?: Uint8Array | undefined;
	/** The environment's database, as `HOST_API` takes it. */
	readonly database?: TenantDbShape | undefined;
	/** The guests' CPU slot, meter and budget, and their warm pool. */
	readonly guests?: GuestIsolatesOptions | undefined;
};
export type NodePorts = {
	readonly artifact?: ArtifactPort;
	readonly keys?: KeysPort;
	readonly database?: HostTenantDb;
	readonly guestIsolates: NodeGuestIsolates;
	readonly http: HttpPort;
	readonly images: ImagesPort;
	readonly mcp: McpPort;
	readonly docs: DocsPort;
};

/** The ports, alive until the scope closes: guest isolates and MCP sessions end with it. */
export const nodePorts = Effect.fn('node.ports')(function* (options: NodePortsOptions = {}) {
	const ports: NodePorts = {
		...(options.release === undefined ? {} : { artifact: artifactPort(options.release) }),
		...(options.secretsKey === undefined ? {} : { keys: keysPort(options.secretsKey) }),
		...(options.database === undefined ? {} : { database: tenantDbPort(options.database) }),
		guestIsolates: yield* guestIsolates(options.guests ?? {}),
		http: httpPort,
		images: imagesPort,
		mcp: yield* mcpPort,
		docs: docsPort()
	};
	return ports;
});
