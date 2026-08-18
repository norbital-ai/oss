import { Schema } from 'effect';
import type { InvocationScope } from '@norbital-ai/bolt-protocol';
import { SyncChange, SyncCursor } from './runtime/sync/sync.js';

export type BoltTransport = Readonly<{
	readonly command: (command: string, input: Schema.Json, signal?: AbortSignal) => Promise<unknown>;
}>;

export type BoltClient = Readonly<{
	readonly scope: InvocationScope;
	readonly command: <S extends Schema.ConstraintDecoder<unknown>>(command: string, input: Schema.Json, output: S, signal?: AbortSignal) => Promise<S['Type']>;
}>;

/** Owns authenticated transport decoding and the collection, remote, and sync client views built on top of it. */
const ClientFactories = {
	bolt: (scope: InvocationScope, transport: BoltTransport): BoltClient => ({
		scope,
		command: async (command, input, output, signal) => Schema.decodeUnknownPromise(output)(await transport.command(command, input, signal))
	}),
	collection: (client: BoltClient, collection: string) => ({
		// The command answers one keyset page. This view takes a row count and gives back rows, so it
		// reads the page apart here rather than making every caller of it learn about cursors.
		findMany: async (limit = 100, signal?: AbortSignal) =>
			(await client.command('collections.findMany', { collection, limit }, Schema.Struct({ rows: Schema.Array(Schema.Json) }), signal)).rows
	}),
	remote: (client: BoltClient, command: string) =>
		(input: Schema.Json, signal?: AbortSignal) => client.command(command, input, Schema.Json, signal),
	sync: (client: BoltClient) => ({
		head: (signal?: AbortSignal) => client.command('sync.head', null, SyncCursor, signal),
		diff: (cursor: SyncCursor, limit = 500, signal?: AbortSignal) => client.command('sync.diff', { cursor, limit }, Schema.Array(SyncChange), signal)
	})
};

export const createBoltClient = ClientFactories.bolt;
export const collectionClient = ClientFactories.collection;
export const remote = ClientFactories.remote;
export const syncClient = ClientFactories.sync;

export { Replica } from './client/replica/replica.js';
export { default as BoltApp } from './client/ui/shell/app.svelte';
export { default as BoltShell } from './client/ui/shell/shell.svelte';
export { default as BoltNavigation } from './client/ui/shell/navigation.svelte';
export {
	AGENT_PATH,
	WORKSPACE_SETTINGS_PATH,
	appAccessAllowed,
	buildApplicationNavigation,
	buildSystemNavigation,
	hostPluginSurfaceHref,
	resolveHostPluginSurface,
	resolveAppHeaderDescription,
	resolveAppHeaderTitle,
	resolveNavigationLabel,
	resolveWorkspaceOrganizationOptions
} from './client/ui/shell/workspace-navigation.js';
export { default as BoltFinder } from './client/ui/shell/omni-finder.svelte';
export { default as BoltNotifications } from './client/ui/shell/notifications.svelte';
export { default as BoltSettings } from './client/ui/settings/workspace.svelte';
export { default as BillingBanner } from './client/ui/shell/billing-banner.svelte';
export { default as AgentChatPanel } from './client/ui/agent/agent-chat-panel.svelte';
export { default as AgentComposer } from './client/ui/agent/composer.svelte';
export { configureAgentRuntime, getAgentRuntime } from './client/ui/agent/client.js';
export { resolveWorkspaceAgentName } from './client/ui/agent/agent-name.js';
export { createHttpBoltTransport } from './client/ui/agent/browser-transport.js';
export { requestAgentComposerFocus } from './client/ui/agent/composer-chrome.js';
export { mergeBoltAgentMessages, boltAgentMessages } from './client/ui/agent/i18n.js';
export type { TenantMessageCatalogs } from './client/ui/agent/i18n.js';
export { setWorkspaceRemoteTransport } from './client/ui/agent/remote-transport.js';
export { default as AgentTranscript } from './client/ui/agent/transcript.svelte';
export { default as AgentMentionPicker } from './client/ui/agent/mention-picker.svelte';
export { default as AgentConversationPicker } from './client/ui/agent/conversation-picker.svelte';
export { default as AgentModelPicker } from './client/ui/agent/model-picker.svelte';
export { default as AgentActivity } from './client/ui/agent/activity.svelte';
export { default as CollectionTable } from './client/ui/collection/table.svelte';
export { default as CollectionRecordDetail } from './client/ui/collection/record-detail.svelte';
export { default as CollectionDetailStack } from './client/ui/collection/detail-stack.svelte';
export { default as WorkspaceMembers, default as WorkspaceInvitations, default as WorkspaceTeams, default as WorkspaceAudit } from './client/ui/settings/workspace.svelte';
export { EMPTY_WORKSPACE_ACCESS } from './client/ui/settings/access.js';
export type { WorkspaceAccess } from './client/ui/settings/access.js';
export { default as AppHeaderActions } from './client/ui/shell/header-actions.svelte';
export { getPlatformStateContext, setPlatformStateContext } from './client/ui/state/platform.js';
export { downloadCollectionExport, importCollectionRecords } from './client/ui/state/import-export.js';
export type { CollectionExportInput, CollectionImportInput, ExportAction, ExportAttachment, ExportManifest } from './client/ui/state/import-export.js';
export { DetailSurfaceService } from './client/ui/collection/detail-surface.js';
export type { DetailRegistration, DetailSurfaceServiceOptions, NavStackItem } from './client/ui/collection/detail-surface.js';
export { uploadFile, WorkspaceFileUploadClient } from './client/ui/state/files.js';
export type { UploadEntry, UploadProgress, UploadResult } from './client/ui/state/files.js';
