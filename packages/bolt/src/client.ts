import { Effect, Schema } from 'effect';
import type { InvocationScope } from '@norbital-ai/bolt-protocol';
import type { BoltClient, BoltTransport } from '#lib/client/contracts.js';
import { decodeUnknownSchema } from '#lib/schema-decode.js';

export type {
	BoltClient,
	BoltTransport,
	CollectionMutationValues,
	MemoryMutationResult,
	MutationSettlement,
	MutationSettlementHandle,
	MutationSettlementStatus,
	RemoteQuery,
	WorkspaceClientRuntime
} from '#lib/client/contracts.js';

/** Owns authenticated transport decoding and the remote client view built on top of it. */
const ClientFactories = {
	bolt: (scope: InvocationScope, transport: BoltTransport): BoltClient => ({
		scope,
		command: <S extends Schema.Top>(
			command: string,
			input: Schema.Json,
			output: S,
			signal?: AbortSignal,
			headers?: Readonly<Record<string, string>>
		): Promise<Schema.Schema.Type<S>> => {
			const effect = Effect.gen(function* () {
				const raw = yield* Effect.tryPromise({
					try: () => transport.command(command, input, signal, headers),
					catch: (cause) => cause
				});
				return yield* decodeUnknownSchema(output, raw);
			});
			return signal === undefined
				? Effect.runPromise(effect)
				: Effect.runPromise(effect, { signal });
		}
	}),
	remote: (client: BoltClient, command: string) => (input: Schema.Json, signal?: AbortSignal) =>
		client.command(command, input, Schema.Json, signal)
};

export const createBoltClient = ClientFactories.bolt;
export const remote = ClientFactories.remote;

/**
 * What a host may reach for, and nothing besides.
 *
 * This barrel used to re-export the whole workspace UI — the shell, the settings surfaces, the agent
 * panel, every collection component — because the host rendered those itself. It does not any more:
 * a compiled tenant bundle owns the workspace UI end to end, and a host that imported a component
 * from here would be importing it from its *own* copy of Svelte, which cannot share a tree or a
 * context key with the bundle's. That is precisely the defect the consolidation removes, so the
 * exports that made it expressible are gone.
 *
 * What is left is the seam: mount a workspace, build the transport and file store it will run on,
 * and the two constants a host needs to route to it.
 */
/**
 * The mount seam itself is `@norbital-ai/bolt/client/workspace`, not this barrel.
 *
 * Deliberate: `mountWorkspace` reaches the whole workspace component tree, and anything re-exporting
 * it drags that tree into the importer's module graph. A host importing this barrel for a transport
 * would then compile the entire workspace UI into its own bundle — which is the arrangement this
 * change exists to end. The *types* below are erased, so they cost nothing and keep both ends of the
 * dynamic import in agreement.
 */
export type {
	AppGroup,
	AppMeta,
	CompiledWorkspace,
	HostMountOptions,
	MountWorkspaceOptions,
	WorkspaceEntry,
	WorkspaceHandle,
	WorkspaceHostActions,
	WorkspaceView
} from './client/ui/shell/workspace-contract.js';
export type {
	WorkspaceFilesHost,
	WorkspaceOperationsHost,
	WorkspaceSession
} from './client/session.js';
export { createHttpBoltTransport } from './client/ui/agent/browser-transport.js';
export type { HttpBoltTransportOptions } from './client/ui/agent/browser-transport.js';
export { AGENT_PATH, WORKSPACE_SETTINGS_PATH } from './client/ui/shell/workspace-navigation.js';
export type { TenantMessageCatalogs } from './client/ui/agent/i18n.js';
export { getPlatformStateContext, setPlatformStateContext } from './client/ui/state/platform.js';
export {
	downloadCollectionExport,
	importCollectionRecords
} from './client/ui/state/import-export.js';
export type {
	CollectionExportInput,
	CollectionImportInput,
	ExportAction,
	ExportAttachment,
	ExportManifest
} from './client/ui/state/import-export.js';
