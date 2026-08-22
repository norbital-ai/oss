import type { WorkspaceSession } from '#lib/client/session.js';
import type { TenantMessageCatalogs } from '#lib/client/ui/agent/i18n.js';
import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
import type { Component } from 'svelte';
import type { CollectionSurface } from '@norbital-ai/ui/collection-runtime';
import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';

/**
 * The whole of what a host says across the boundary, in three parts.
 *
 * A tenant bundle ships its own Svelte and its own copy of the design system, so nothing structural
 * crosses this seam: not a component, not a snippet, not a context key — two Svelte instances cannot
 * share a component tree, which is why the host used to render these surfaces as children inside
 * `BoltApp` and why the compiled bundle could not be consumed at all. What crosses is data, callbacks
 * and one imperative handle.
 *
 * Reactivity does not cross it either. A `$state` proxy created by the host's Svelte registers its
 * reads in the host's reactive graph, so an effect inside the bundle would never see it change. The
 * handle's `update` is what carries a changed view in: it assigns into a state object the *bundle*
 * created, which is the only object the bundle's own effects can be watching.
 */

/** Who is looking, where they are, and which organizations they could switch to. */
export type WorkspaceView = {
	/** The routed organization. The host answers this per navigation, never from a stale document. */
	readonly organization: { readonly id: string; readonly name: string };
	readonly organizations: ReadonlyArray<{
		readonly organizationId: string;
		readonly organizationName: string;
		readonly logoUrl: string | null;
	}>;
	readonly user: {
		readonly id: string;
		readonly email: string;
		/**
		 * The roles the credential actually carries.
		 *
		 * Never defaulted. An absent team used to be an absent role list that read as `['admin']`, so a
		 * session the host never reported on was rendered with the highest privilege in the workspace.
		 * No team is no authority, and the runtime re-derives it from the credential on every command
		 * regardless — this is for display and for the local replica's own decisions.
		 */
		readonly team?: string;
		/** The team names whose policies this session holds — its own, then any it inherits. */
		readonly teamPath: ReadonlyArray<string>;
		/** Administration is a status the host proved, not a role borrowed off the list above. */
		readonly admin: boolean;
	};
	readonly path: string;
	/** Live query string, for the detail surface that reads `?stack=`. */
	readonly search: string;
};

/**
 * What the workspace asks the host to do, because only the host can do it.
 *
 * Routing, sign-out and the organization cookie belong to whatever is hosting this bundle. The
 * workspace states the intent; the host decides whether that is a client navigation, a cookie plus a
 * document load, or something else entirely.
 */
export type WorkspaceHostActions = {
	/**
	 * Go to a path the workspace built.
	 *
	 * `replace` is not decoration: opening an app group lands on the group's URL and immediately
	 * corrects to its default child, and without replacing the entry the browser's Back button walks
	 * the reader through a redirect they never saw.
	 */
	readonly navigate: (href: string, options?: { readonly replace?: boolean }) => void;
	readonly signOut: () => void;
	readonly changeOrganization: (organizationId: string) => void;
	/**
	 * Persist a team preview that the runtime has already accepted.
	 *
	 * Called only after `access.impersonateTeam` succeeded: the tenant runtime is the authority on
	 * whether this session may preview, and storing the choice before it agreed turned one refused
	 * click into every later command failing with nothing on screen saying why.
	 */
	readonly impersonate: (teamId: string) => void;
	readonly stopImpersonating: () => void;
};

export type AppGroup = Readonly<{
	readonly defaultChild?: string;
	readonly label?: string;
	readonly description?: string;
	readonly icon?: string;
}>;

export type AppMeta = Readonly<{
	readonly label?: string;
	readonly icon?: string;
	readonly description?: string;
	readonly banner?: string;
	readonly thumbnail?: string;
}>;

/**
 * Everything `bolt sync` generated for this tenant, as the workspace entry hands it over.
 *
 * These are not props from the host and must never become props from the host. They are facts about
 * the compiled workspace, and they arrive from the bundle's own `$bolt/*` modules — which is the
 * whole point of the bundle owning the UI: there is no registry keyed by tenant to look the wrong
 * organization up in.
 */
export type CompiledWorkspace = Readonly<{
	readonly title: string;
	readonly name: string;
	readonly appLoaders: Readonly<Record<string, () => Promise<Component>>>;
	readonly appGroups: Readonly<Record<string, AppGroup>>;
	readonly appMeta: Readonly<Record<string, AppMeta>>;
	readonly representationLoaders: Readonly<
		Record<string, () => Promise<NonNullable<CollectionSurface['representation']>>>
	>;
	readonly customTypeRendererLoaders: Readonly<
		Record<string, () => Promise<CustomTypeRendererMap[string]>>
	>;
	readonly policyNames: ReadonlyArray<string>;
	readonly tenantMessages: TenantMessageCatalogs;
	/** The workspace's own collection client, for Studio's Data tab. */
	readonly client: WorkspaceClient;
	/** Withdraws browser data from the previous policy scope before reactive reads resume. */
	readonly changeAccessScope: (accessScope: string) => void;
	/** Boots the local PGlite replica against the same runtime `client` reads through. */
	readonly startLocalReplica: (accessScope: string) => Promise<{ readonly stop: () => void }>;
}>;

/**
 * Everything a host states when it mounts a workspace — and nothing about the workspace itself.
 *
 * The split from `MountWorkspaceOptions` is the point of the whole seam: a host says who is looking,
 * where they are, what it will do when asked, and which host capabilities exist. What the workspace
 * *is* comes from the workspace, and a host has no way to assert it.
 */
export type HostMountOptions = Readonly<{
	readonly session: WorkspaceSession;
	readonly view: WorkspaceView;
	readonly actions: WorkspaceHostActions;
}>;

export type MountWorkspaceOptions = HostMountOptions &
	Readonly<{
		/**
		 * Loads the compiled workspace, after the session has been declared.
		 *
		 * A loader rather than a value: importing the generated client builds the browser runtime, and
		 * that runtime's query cache is namespaced by tenant and environment. Built before the session
		 * was declared it would be a cache shared between organizations. Supplied by the workspace
		 * entry, which is the one module that may name `$bolt/*`.
		 */
		readonly loadWorkspace: () => Promise<CompiledWorkspace>;
	}>;

/**
 * The shape of a compiled workspace's entry module, as a host sees it over the wire.
 *
 * A host imports this by URL from the artifact it is serving, so nothing types the import for it.
 * Naming the shape here is what keeps the two ends of a dynamic import in agreement.
 */
export type WorkspaceEntry = Readonly<{
	readonly mountWorkspace: (
		target: HTMLElement,
		options: HostMountOptions
	) => Promise<WorkspaceHandle>;
}>;

/** The host's grip on a mounted workspace: change what it is showing, or take it down. */
export type WorkspaceHandle = Readonly<{
	readonly update: (view: WorkspaceView) => void;
	readonly destroy: () => void;
}>;
