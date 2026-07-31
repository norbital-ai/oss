import type { ManifestApp } from '@norbital-ai/platform-utils/manifest/types';
import { humanize } from '@norbital-ai/std/string';
import type {
	WorkspaceNavigationItem,
	WorkspaceOrganizationOption
} from '@norbital-ai/ui/workspace-shell';

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
		if (!organization.organizationId || optionsById.has(organization.organizationId)) continue;
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

/** A Pod-owned agent surface exists only when the host explicitly registers that exact entry. */
export function hostAuthorizesAgentSurface(
	currentPath: string,
	plugins: readonly { readonly key: string; readonly entry: string }[]
): boolean {
	return (
		currentPath === '/agent' &&
		plugins.some((plugin) => plugin.key === 'agent' && plugin.entry === '/agent')
	);
}

function isUnder(currentPath: string, entry: string): boolean {
	return currentPath === entry || currentPath.startsWith(`${entry}/`);
}

/**
 * The system section of the sidebar: Pod's own surfaces, then the host's.
 *
 * Settings is listed by the pod itself rather than by a host plugin, and that is the whole point of
 * it. A workspace started with `pod start` has no host plugins — `data.hostPlugins` is empty — so an
 * entry added through that path would exist only on a workspace hosted by Core, which is exactly the
 * workspace that needs it least. Managing users, teams and invitations has to be reachable from a
 * standalone pod.
 *
 * Host surfaces are links, not apps: the pod never loads their code, so there is no manifest entry,
 * no access grant, and no nesting. `adminOnly` filtering happens here for presentation only — every
 * route behind these entries, Pod's included, authorizes its own requests, since the URL is visible
 * in the markup whether or not a link to it is.
 */
export function buildSystemNavigation(input: {
	plugins: readonly {
		readonly key: string;
		readonly label: string;
		readonly icon: string | null;
		readonly entry: string;
		readonly adminOnly?: boolean;
	}[];
	isAdmin: boolean;
	currentPath: string;
}): WorkspaceNavigationItem[] {
	const podSurfaces: WorkspaceNavigationItem[] = input.isAdmin
		? [
				{
					key: 'pod-settings',
					label: 'Settings',
					icon: 'lucide:settings',
					href: WORKSPACE_SETTINGS_PATH,
					active: isUnder(input.currentPath, WORKSPACE_SETTINGS_PATH)
				}
			]
		: [];
	return [
		...podSurfaces,
		...input.plugins
			.filter((plugin) => input.isAdmin || !plugin.adminOnly)
			.map((plugin) => ({
				key: plugin.key,
				label: plugin.label,
				icon: plugin.icon,
				href: plugin.entry,
				active: isUnder(input.currentPath, plugin.entry)
			}))
	];
}

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

export function buildApplicationNavigation(input: {
	appIds: readonly string[];
	apps: Readonly<Record<string, ManifestApp>>;
	accessibleAppNames: readonly string[] | null;
	currentPath: string;
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
			label: app?.label?.trim() || humanize(id.split('/').at(-1) ?? id),
			icon: app?.icon ?? 'lucide:layout-grid',
			href,
			active,
			featureColor: 'customApps',
			...(children.length > 0 ? { children } : {})
		};
	};

	return rootIds.sort().map(buildItem);
}
