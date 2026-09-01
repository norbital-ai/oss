export { createSyncClient, SyncAttachmentError } from './client.js';
export type {
	MountedLiveQuery,
	SyncAttachmentFailureKind,
	SyncClient,
	SyncClientOptions,
	SyncWorkspaceAttachment,
	SyncWorkspaceAttachmentListener
} from './client.js';
export { createBrowserSyncBroker } from './sse-driver.js';
export type {
	BrowserSyncBroker,
	BrowserSyncBrokerOptions,
	BrowserSyncProfileElection,
	BrowserSyncScope,
	BrowserSyncWorkspaceBinding,
	BrowserSyncWorkspaceBindingOptions,
	BrowserSyncWorkspaceControls,
	EventSourceLike
} from './sse-driver.js';
export { createSyncHttpDriver, SyncHttpError } from './http-driver.js';
export type { SyncHttpDriver, SyncHttpDriverOptions, SyncPushRequest } from './http-driver.js';
export {
	applyPrefixDelta,
	applyPrefixUpdate,
	applyPrefixUpdates,
	extendRetainedPrefix,
	initialClientState,
	DETACH_GRACE_MS,
	STALE_WRITE_MS,
	step
} from './machine.js';
export type {
	ClientEffect,
	ClientEvent,
	ClientState,
	DisconnectCause,
	QueryPhase,
	QueryState,
	VersionedPrefixState,
	WriteState
} from './machine.js';
