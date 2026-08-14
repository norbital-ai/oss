import type { ManifestApp } from '@norbital-ai/platform-utils/manifest/types';
import { humanize } from '@norbital-ai/std/string';
import type {
	WorkspaceNavigationItem,
	WorkspaceOrganizationOption
} from '@norbital-ai/ui/workspace-shell';

/**
 * The subset of the i18n api the navigation label resolution needs, with an open
 * key type: app and group titles live under `app.<id>.title`, which tenant
 * catalogs define and this catalog cannot type.
 */
export type NavigationLabelResolver = {
	has(key: string): boolean;
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};

/**
 * Start an application load for the current navigation attempt.
 *
 * Native dynamic imports already deduplicate fetched and evaluated modules. Keeping a second
 * promise cache in the shell made a transient, never-settling request permanent: every later visit
 * reused that stale promise until the document was refreshed. A navigation attempt therefore asks
 * the loader for a fresh promise and leaves module reuse to the browser.
 */
export function loadWorkspaceApplication<T>(
	loaders: Readonly<Record<string, () => Promise<T>>>,
	name: string
): Promise<T> | undefined {
	return loaders[name]?.();
}

/**
 * The app-title localization chokepoint.
 *
 * App and group display labels resolve through the tenant catalog before any
 * metadata fallback: `app.<id>.title` wins, then the manifest label, then the
 * humanized id. The same path is used for a group and its apps, so a tenant can
 * translate its navigation per locale without touching the shell.
 */
export function resolveNavigationLabel(
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string
): string {
	if (!i18n) return fallback;
	const key = `app.${id}.title`;
	return i18n.has(key) ? i18n.t(key) : fallback;
}

/**
 * Compact app chrome title: page header copy first, then the nav label, then the
 * static manifest / humanized fallback.
 */
export function resolveAppHeaderTitle(
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string
): string {
	if (i18n) {
		const headerKey = `app.${id}.header_title`;
		if (i18n.has(headerKey)) return i18n.t(headerKey);
	}
	return resolveNavigationLabel(i18n, id, fallback);
}

/**
 * Compact app chrome description: dedicated header copy, else the manifest
 * description. Returns null when neither exists so the chrome can omit the line.
 */
export function resolveAppHeaderDescription(
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string | null | undefined
): string | null {
	if (i18n) {
		const key = `app.${id}.header_description`;
		if (i18n.has(key)) return i18n.t(key);
	}
	const trimmed = fallback?.trim();
	return trimmed ? trimmed : null;
}

/** Deduplicates organizations by id, filling a missing logo from a later listing. */
export function resolveWorkspaceOrganizationOptions(input: {
	activeOrganization: WorkspaceOrganizationOption;
	organizations: readonly {
		readonly organizationId: string;
		readonly organizationName: string;
		readonly logoUrl: string | null;
	}[];
}): WorkspaceOrganizationOption[] {
	const optionsById = new Map<string, WorkspaceOrganizationOption>([
		[input.activeOrganization.id, input.activeOrganization]
	]);
	for (const organization of input.organizations) {
		if (!organization.organizationId) continue;
		const existing = optionsById.get(organization.organizationId);
		if (existing) {
			if (!existing.logoUrl && organization.logoUrl) {
				optionsById.set(organization.organizationId, {
					...existing,
					logoUrl: organization.logoUrl
				});
			}
			continue;
		}
		optionsById.set(organization.organizationId, {
			id: organization.organizationId,
			name: organization.organizationName,
			logoUrl: organization.logoUrl
		});
	}
	return [...optionsById.values()];
}

/** Pod's own administration surface. Rendered by the pod, so it is not a host plugin. */
export const WORKSPACE_SETTINGS_PATH = '/settings';
export const HOST_PLUGIN_SURFACE_PREFIX = '/__host';

/** Builds the in-pod href for a host plugin surface from its key. */
// stupidity:allow Q4 -- named helper
export function hostPluginSurfaceHref(pluginKey: string): string {
	return `${HOST_PLUGIN_SURFACE_PREFIX}/${encodeURIComponent(pluginKey)}`;
}

/**
 * The host surface that owns subscriptions, and the tab within it that shows them.
 *
 * Pod's trial banner deep-links here, so it has to name a surface Pod does not implement. The pair
 * is stated once rather than at the call site because the query string is load-bearing: the shell
 * forwards `location.search` into the host frame, and that is the only thing that tells a tabbed
 * host surface which tab to open. A banner linking at the surface without the tab lands an admin on
 * whichever tab the host defaults to, which is the one they were not asking for.
 */
export const BILLING_HOST_PLUGIN_KEY = 'core-organization';
export const BILLING_HOST_PLUGIN_TAB = 'billing';

/** `null` when the host declares no billing surface, so the banner can omit the action entirely. */
export function resolveBillingSettingsHref(
	plugins: readonly { readonly key: string }[]
): string | null {
	if (!plugins.some((plugin) => plugin.key === BILLING_HOST_PLUGIN_KEY)) return null;
	return `${hostPluginSurfaceHref(BILLING_HOST_PLUGIN_KEY)}?tab=${BILLING_HOST_PLUGIN_TAB}`;
}

/**
 * Host-plugin entries cross out of Pod's in-memory router.
 *
 * A host route can happen to share this origin, but it is still served by a different application
 * boundary. Treating it as a Pod SPA route only changes `history` and leaves the current Pod shell
 * trying to render a route it does not own.
 */
export function isHostPluginEntry(
	href: string,
	plugins: readonly { readonly entry: string }[]
): boolean {
	return plugins.some((plugin) => plugin.entry === href);
}

/** Returns the host plugin whose surface matches the current path, or null. */
export function resolveHostPluginSurface(
	currentPath: string,
	plugins: readonly { readonly key: string; readonly entry: string }[]
): { readonly key: string; readonly entry: string } | null {
	return plugins.find((plugin) => currentPath === hostPluginSurfaceHref(plugin.key)) ?? null;
}

/**
 * Every workspace has the safe interactive agent fallback implemented by Pod. An authored agent
 * profile can add approved tools and instructions, but it is not required for the surface itself.
 */
// stupidity:allow Q4 -- named helper
export function workspaceProvidesAgentSurface(): boolean {
	return true;
}

/** The optional full-page route is Pod-owned for every workspace. */
// stupidity:allow Q4 -- named helper
export function workspaceAuthorizesAgentSurface(currentPath: string): boolean {
	return currentPath === '/agent';
}

/** True when the current path is the entry or a nested path under it. */
// stupidity:allow Q4 -- named helper
function isUnder(currentPath: string, entry: string): boolean {
	return currentPath === entry || currentPath.startsWith(`${entry}/`);
}

/**
 * The host-plugin label localization chokepoint.
 *
 * Host plugin labels are host-owned English by default; a pod/tenant catalog can override them
 * under `pod.shell.hostPlugin.<key>` (or `app.<key>.title`) without touching the shell.
 */
export function resolveHostPluginLabel(
	i18n: NavigationLabelResolver | undefined,
	pluginKey: string,
	fallback: string
): string {
	if (!i18n) return fallback;
	const key = `pod.shell.hostPlugin.${pluginKey}`;
	return i18n.has(key) ? i18n.t(key) : fallback;
}

/**
 * The system section of the sidebar: a Settings folder, then standalone host tools.
 *
 * Settings is listed by the pod itself rather than by a host plugin, and that is the whole point of
 * it. A workspace started with `pod start` has no host plugins — `data.hostPlugins` is empty — so an
 * entry added through that path would exist only on a workspace hosted by Core, which is exactly the
 * workspace that needs it least. Managing users, teams and invitations has to be reachable from a
 * standalone pod.
 *
 * Host surfaces are links, not apps: the pod never loads their code, so there is no manifest entry
 * or access grant. `placement: settings` lets a host put its own facilities under the Settings
 * folder without pretending Pod owns them. `adminOnly` filtering happens here for presentation
 * only — every route behind these entries, Pod's included, authorizes its own requests, since the
 * URL is visible in the markup whether or not a link to it is.
 */
export function buildSystemNavigation(input: {
	plugins: readonly {
		readonly key: string;
		readonly label: string;
		readonly icon: string | null;
		readonly entry: string;
		readonly placement?: 'sidebar' | 'settings' | 'footer';
		readonly adminOnly?: boolean;
	}[];
	isAdmin: boolean;
	currentPath: string;
	/** Resolves pod chrome labels; falls back to the source English when absent. */
	i18n?: NavigationLabelResolver;
}): WorkspaceNavigationItem[] {
	const { i18n } = input;
	const visiblePlugins = input.plugins.filter(
		(inputPlugin) => inputPlugin.placement !== 'footer' && (input.isAdmin || !inputPlugin.adminOnly)
	);
	/** Maps a visible host plugin to a sidebar item with an in-pod surface href. */
	const pluginItem = (plugin: (typeof visiblePlugins)[number]): WorkspaceNavigationItem => {
		const href = hostPluginSurfaceHref(plugin.key);
		return {
			key: plugin.key,
			label: resolveHostPluginLabel(i18n, plugin.key, plugin.label),
			icon: plugin.icon,
			href,
			active: isUnder(input.currentPath, href),
			...(plugin.key.startsWith('core-') ? { badge: 'Core' } : {})
		};
	};
	const settingsChildren: WorkspaceNavigationItem[] = [
		...(input.isAdmin
			? [
					{
						key: 'pod-settings',
						// Named for what an admin manages here — members, invitations, teams, the audit
						// trail — not for the tenant database those rows happen to live in. The storage was
						// never the thing anyone came to this entry looking for.
						label: i18n ? i18n.t('pod.shell.people') : 'People',
						icon: 'lucide:users',
						href: WORKSPACE_SETTINGS_PATH,
						active: isUnder(input.currentPath, WORKSPACE_SETTINGS_PATH)
					} satisfies WorkspaceNavigationItem
				]
			: []),
		...visiblePlugins.filter((plugin) => plugin.placement === 'settings').map(pluginItem)
	];
	const settings: WorkspaceNavigationItem[] = settingsChildren.length
		? [
				{
					key: 'settings',
					label: i18n ? i18n.t('pod.shell.settings') : 'Settings',
					icon: 'lucide:settings',
					href: settingsChildren[0].href,
					active: settingsChildren.some((item) => item.active),
					children: settingsChildren
				}
			]
		: [];
	return [
		...settings,
		...visiblePlugins.filter((plugin) => plugin.placement !== 'settings').map(pluginItem)
	];
}

/** Account-adjacent host tools such as admin impersonation. */
export function buildUtilityNavigation(input: {
	plugins: readonly {
		readonly key: string;
		readonly label: string;
		readonly icon: string | null;
		readonly entry: string;
		readonly placement?: 'sidebar' | 'settings' | 'footer';
		readonly adminOnly?: boolean;
	}[];
	isAdmin: boolean;
	currentPath: string;
}): WorkspaceNavigationItem[] {
	return input.plugins
		.filter(
			(plugin) => plugin.placement === 'footer' && (input.isAdmin || plugin.adminOnly !== true)
		)
		.map((plugin) => {
			const href = hostPluginSurfaceHref(plugin.key);
			return {
				key: plugin.key,
				label: plugin.label,
				icon: plugin.icon,
				href,
				active: isUnder(input.currentPath, href)
			};
		});
}

/** Grants access when the list is unrestricted or names this app or an ancestor. */
export function appAccessAllowed(
	appId: string,
	accessibleAppNames: readonly string[] | null
): boolean {
	if (accessibleAppNames === null) return true;
	return accessibleAppNames.some((entry) => {
		const grant = entry.trim();
		return grant === appId || (grant.length > 0 && appId.startsWith(`${grant}/`));
	});
}

/** Walks defaultChild until a granted, available app id is found. */
export function resolveApplicationLandingAppId(input: {
	requestedAppId: string;
	appIds: readonly string[];
	apps: Readonly<Record<string, ManifestApp>>;
	accessibleAppNames: readonly string[] | null;
}): string | null {
	const availableAppIds = new Set(input.appIds);
	const fallbackAppId = [...availableAppIds]
		.filter(
			(appId) =>
				appId.startsWith(`${input.requestedAppId}/`) &&
				appAccessAllowed(appId, input.accessibleAppNames)
		)
		.sort()[0];
	let candidate = input.requestedAppId;
	const visited = new Set<string>();

	while (!availableAppIds.has(candidate)) {
		if (visited.has(candidate)) return fallbackAppId ?? null;
		visited.add(candidate);
		const defaultChild = input.apps[candidate]?.defaultChild?.trim();
		if (!defaultChild || !appAccessAllowed(defaultChild, input.accessibleAppNames)) {
			return fallbackAppId ?? null;
		}
		candidate = defaultChild;
	}

	return appAccessAllowed(candidate, input.accessibleAppNames)
		? candidate
		: (fallbackAppId ?? null);
}

/** Builds the sidebar tree of granted apps from parent/child manifest links. */
export function buildApplicationNavigation(input: {
	appIds: readonly string[];
	apps: Readonly<Record<string, ManifestApp>>;
	accessibleAppNames: readonly string[] | null;
	currentPath: string;
	/** Resolves app/group titles through the tenant catalog (`app.<id>.title`). */
	i18n?: NavigationLabelResolver;
}): WorkspaceNavigationItem[] {
	const leafIds = new Set(
		input.appIds.filter((appId) => appAccessAllowed(appId, input.accessibleAppNames))
	);
	const visibleIds = new Set(leafIds);
	for (const leafId of leafIds) {
		let parent = input.apps[leafId]?.parent ?? null;
		while (parent) {
			visibleIds.add(parent);
			parent = input.apps[parent]?.parent ?? null;
		}
	}

	const childrenByParent = new Map<string, string[]>();
	const rootIds: string[] = [];
	for (const id of visibleIds) {
		const parent = input.apps[id]?.parent;
		if (parent && visibleIds.has(parent)) {
			childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), id]);
		} else {
			rootIds.push(id);
		}
	}

	/** Builds one navigation node and its granted children from a manifest app id. */
	const buildItem = (id: string): WorkspaceNavigationItem => {
		const app = input.apps[id];
		const children = (childrenByParent.get(id) ?? []).sort().map(buildItem);
		const landingAppId = resolveApplicationLandingAppId({
			requestedAppId: id,
			appIds: children.map((child) => child.key),
			apps: input.apps,
			accessibleAppNames: input.accessibleAppNames
		});
		const defaultChild = children.find((child) => child.key === landingAppId);
		const href = defaultChild?.href ?? children[0]?.href ?? `/app/${id}`;
		const active =
			children.some((child) => child.active) ||
			input.currentPath === `/app/${id}` ||
			input.currentPath.startsWith(`/app/${id}/`);
		return {
			key: id,
			label: resolveNavigationLabel(
				input.i18n,
				id,
				app?.label?.trim() || humanize(id.split('/').at(-1) ?? id)
			),
			icon: app?.icon ?? 'lucide:layout-grid',
			href,
			active,
			featureColor: 'customApps',
			...(children.length > 0 ? { children } : {})
		};
	};

	return rootIds.sort().map(buildItem);
}
