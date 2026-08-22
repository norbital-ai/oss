import type { BoltTransport } from '#lib/client.js';

/**
 * The host capabilities a workspace surface may use, named one by one.
 *
 * Everything here used to be reached ambiently. The credential, the tenant, the environment and the
 * release were read off `document.documentElement.dataset` by four different modules; the command
 * endpoint, the file endpoint and the host operations endpoint were spelled as literal paths inside
 * whichever component needed them. Both are the same defect — a surface silently working because a
 * value happened to be in scope, and silently doing the wrong thing when it was not, or when it was
 * the *previous* page's value. A document attribute is written when a document is served, and this
 * client mounts across navigations that serve no document.
 *
 * So the host states all of it once, by name, when it mounts the workspace. A surface that needs a
 * capability is given it; a surface that is given nothing can do nothing, which is the point.
 */
export type WorkspaceFilesHost = Readonly<{
	/**
	 * Stores one file under a key the caller names, and answers with the URL it reads back from.
	 *
	 * The caller names the key because some of them mean something: an organization's logo is stored
	 * at `org-branding/logo-<uuid>.<ext>` so the extension carries the media type, and the record that
	 * points at it stores the key rather than the URL. A record field is not a place to keep a host's
	 * routing table, which is what storing the URL would make it.
	 */
	readonly store: (
		key: string,
		file: File,
		onProgress?: (progress: { readonly loaded: number; readonly total: number }) => void,
		signal?: AbortSignal
	) => Promise<string>;
	/** Drops the bytes stored under a key. */
	readonly remove: (key: string) => Promise<void>;
	/** Where a stored key is served from, so a surface can render one without knowing the host. */
	readonly urlFor: (key: string) => string;
}>;

/**
 * The host's own release operations, which are not tenant commands.
 *
 * `workspace.manifest` and `secrets.status` are answered by the artifact through the transport.
 * Building a release, rolling one back and reading what is currently routed are answered by the
 * *host*, because only the host holds the release table. The Studio needs both and they are two
 * different authorities, so they are two different members here rather than one `fetch`.
 */
export type WorkspaceOperationsHost = Readonly<{
	/**
	 * The host snapshot. `billing` costs two Stripe round trips, so it is asked for rather than
	 * assumed — a surface that does not show money should not wait on a payments API to render.
	 */
	readonly read: (options?: { readonly billing?: boolean }) => Promise<unknown>;
	readonly run: (input: unknown) => Promise<unknown>;
}>;

export type WorkspaceSession = Readonly<{
	readonly tenantId: string;
	readonly environment: string;
	readonly releaseId: string;
	/**
	 * The authority-shaped browser scope this document is currently rendering.
	 *
	 * It is not an authorization input — every command is still checked by the runtime. It keeps
	 * policy-filtered query answers and the local replica for an administrator separate from the
	 * replicas opened while that administrator previews a team.
	 */
	readonly accessScope: string;
	/** The signed-in operator's bearer credential, without the `Bearer ` prefix. */
	readonly credential: string;
	readonly transport: BoltTransport;
	/**
	 * Where the local replica opens its change stream.
	 *
	 * A URL, because an `EventSource` needs one and cannot go through the command transport. It was a
	 * `SYNC_STREAM_PATH` constant inside the replica — one host's route compiled into the framework,
	 * so the replica only ever learned about changes when it happened to be running inside that host.
	 */
	readonly syncStreamUrl: string;
	readonly files: WorkspaceFilesHost;
	readonly operations: WorkspaceOperationsHost;
}>;

let session: WorkspaceSession | undefined;

/**
 * Declares the session every later read runs under.
 *
 * Called by `mountWorkspace` before the generated client is imported, because importing it builds
 * the browser runtime and that runtime's query cache is namespaced by tenant, environment, and
 * access scope. A cache namespaced from a value that arrives later is a cache shared between
 * organizations or policy scopes.
 */
export const setWorkspaceSession = (next: WorkspaceSession): void => {
	session = next;
};

/**
 * The session, or a refusal.
 *
 * No default and no fallback. A default here would be a workspace rendering as `local`/`development`
 * against whatever credential the browser happened to still have — which is exactly how a signed-out
 * shell used to render as a named administrator. If the host has not said who this is, nothing may
 * proceed on a guess.
 */
export const workspaceSession = (): WorkspaceSession => {
	if (session === undefined) {
		throw new Error(
			'No workspace session has been declared. The host must call mountWorkspace before any workspace surface reads.'
		);
	}
	return session;
};
