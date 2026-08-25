import { Effect, Schema } from 'effect';
import type { InvocationScope } from '@norbital-ai/bolt-protocol';
import { SyncChange, SyncCursor } from '#lib/runtime/sync/sync.js';
import type { BoltClient, BoltTransport } from '#lib/client/contracts.js';

export type { BoltClient, BoltTransport } from '#lib/client/contracts.js';

/** One page of a keyset read, built once rather than per call. */
const CollectionPage = Schema.Struct({ rows: Schema.Array(Schema.Json) });

/** Owns authenticated transport decoding and the collection, remote, and sync client views built on top of it. */
const ClientFactories = {
	bolt: (scope: InvocationScope, transport: BoltTransport): BoltClient => ({
		scope,
		command: (command, input, output, signal) => {
			// Built before the request rather than inside the pipe: the decoder belongs to the schema the
			// caller named, not to the response it happens to be applied to.
			const decode = Schema.decodeUnknownEffect(output);
			return Effect.runPromise(
				Effect.tryPromise({
					try: () => transport.command(command, input, signal),
					catch: (cause) => cause
				}).pipe(Effect.flatMap(decode))
			);
		}
	}),
	collection: (client: BoltClient, collection: string) => ({
		// The command answers one keyset page. This view takes a row count and gives back rows, so it
		// reads the page apart here rather than making every caller of it learn about cursors.
		findMany: (limit = 100, signal?: AbortSignal) =>
			Effect.runPromise(
				Effect.tryPromise({
					try: () =>
						client.command('collections.findMany', { collection, limit }, CollectionPage, signal),
					catch: (cause) => cause
				}).pipe(Effect.map((page) => page.rows))
			)
	}),
	remote: (client: BoltClient, command: string) => (input: Schema.Json, signal?: AbortSignal) =>
		client.command(command, input, Schema.Json, signal),
	sync: (client: BoltClient) => ({
		head: (signal?: AbortSignal) => client.command('sync.head', null, SyncCursor, signal),
		diff: (cursor: SyncCursor, limit = 500, signal?: AbortSignal) =>
			client.command('sync.diff', { cursor, limit }, Schema.Array(SyncChange), signal)
	})
};

export const createBoltClient = ClientFactories.bolt;
export const collectionClient = ClientFactories.collection;
export const remote = ClientFactories.remote;
export const syncClient = ClientFactories.sync;

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
