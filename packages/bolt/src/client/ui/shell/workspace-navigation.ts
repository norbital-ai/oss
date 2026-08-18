import type {
	WorkspaceNavigationItem,
	WorkspaceOrganizationOption
} from '@norbital-ai/ui/workspace-shell';
import type { AppDeclaration } from '../../../authoring/workspace-schema.js';

export type NavigationLabelResolver = {
	has(key: string): boolean;
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};

export type HostPlugin = Readonly<{
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly entry: string;
	readonly placement?: 'sidebar' | 'settings' | 'footer';
	readonly adminOnly?: boolean;
}>;

export const WORKSPACE_SETTINGS_PATH = '/people';
export const HOST_PLUGIN_SURFACE_PREFIX = '/__host';
export const AGENT_PATH = '/agent';

const NavigationText = {
	humanize: (value: string): string =>
		value.replaceAll(/[-_]/g, ' ').replaceAll(/\b\w/g, (character) => character.toUpperCase())
};

export const hostPluginSurfaceHref = (pluginKey: string): string =>
	`${HOST_PLUGIN_SURFACE_PREFIX}/${encodeURIComponent(pluginKey)}`;

const navigationTitleKeys = (id: string): ReadonlyArray<string> => {
	const leaf = id.includes('/') ? (id.slice(id.lastIndexOf('/') + 1) ?? id) : id;
	return [`app.${id}.title`, `app.${id.replaceAll('/', '.')}.title`, `app.${leaf}.title`];
};

export const resolveNavigationLabel = (
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string
): string => {
	if (i18n === undefined) return fallback;
	const key = navigationTitleKeys(id).find((candidate) => i18n.has(candidate));
	return key === undefined ? fallback : i18n.t(key);
};

export const resolveAppHeaderTitle = (
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string
): string => {
	if (i18n !== undefined) {
		const headerKey = `app.${id}.header_title`;
		if (i18n.has(headerKey)) return i18n.t(headerKey);
	}
	return resolveNavigationLabel(i18n, id, fallback);
};

export const resolveAppHeaderDescription = (
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string | null | undefined
): string | null => {
	if (i18n !== undefined) {
		const key = `app.${id}.header_description`;
		if (i18n.has(key)) return i18n.t(key);
	}
	const trimmed = fallback?.trim();
	return trimmed === undefined || trimmed === '' ? null : trimmed;
};

export const resolveWorkspaceOrganizationOptions = (input: {
	activeOrganization: WorkspaceOrganizationOption;
	organizations: ReadonlyArray<{
		readonly organizationId: string;
		readonly organizationName: string;
		readonly logoUrl: string | null;
	}>;
}): WorkspaceOrganizationOption[] => {
	const optionsById = new Map<string, WorkspaceOrganizationOption>([
		[input.activeOrganization.id, input.activeOrganization]
	]);
	for (const organization of input.organizations) {
		if (organization.organizationId === '') continue;
		const existing = optionsById.get(organization.organizationId);
		if (existing !== undefined) {
			if (existing.logoUrl === undefined && organization.logoUrl !== null) {
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
};

const isUnder = (currentPath: string, entry: string): boolean =>
	currentPath === entry || currentPath.startsWith(`${entry}/`);

export const appAccessAllowed = (
	appId: string,
	accessibleAppNames: ReadonlyArray<string> | null
): boolean => {
	if (accessibleAppNames === null) return true;
	return accessibleAppNames.some((entry) => {
		const grant = entry.trim();
		return grant === appId || (grant.length > 0 && appId.startsWith(`${grant}/`));
	});
};

/**
 * The containers an entry sits inside, nearest first.
 *
 * Two sources, because hosts build the tree two ways: an entry may declare `parent` outright, and a
 * nested app's name is already a path (`hr_controller/leave`) whose own prefix names the group even
 * when nothing declared the link. The walk is bounded and refuses to revisit a name, so a workspace
 * that manages to declare a cycle produces a short chain instead of hanging the sidebar.
 */
const containersOf = (
	app: ShellApp,
	byName: ReadonlyMap<string, ShellApp>
): ReadonlyArray<string> => {
	const chain: string[] = [];
	let cursor: ShellApp | undefined = app;
	while (cursor !== undefined && chain.length < 16) {
		const declared = cursor.parent;
		const index = cursor.name.lastIndexOf('/');
		const parent = declared ?? (index < 0 ? undefined : cursor.name.slice(0, index));
		if (parent === undefined || parent === app.name || chain.includes(parent)) break;
		chain.push(parent);
		cursor = byName.get(parent);
	}
	return chain;
};

/**
 * The entries a subject may see, containers included.
 *
 * The access list names *declared* apps, and a group is not one of them: it is a `+group.ts` sitting
 * beside the app files, so `AccessControl.visibleApps` answers a policy written as
 * `apps: ['hr_controller']` with the eight leaves underneath and never with the group itself.
 * Filtering the host's navigation entries one by one against that list therefore deleted the very
 * heading the grant was written on, and the sidebar came back flat — eight orphaned children
 * promoted to top level, which is precisely the tree this module exists to avoid.
 *
 * So a container survives on its children's behalf: kept while anything beneath it is allowed,
 * dropped only when nothing is. That is what hides "HR Controller" from an employee while leaving it
 * intact, with its children nested under it, for someone in HR.
 */
export const filterAccessibleApps = <App extends ShellApp>(
	apps: ReadonlyArray<App>,
	accessibleAppNames: ReadonlyArray<string> | null | undefined
): ReadonlyArray<App> => {
	// `null`/absent stays "the host has not restricted anything" — the only honest reading when the
	// host never had a list to give. Every caller that predates access filtering keeps its behaviour.
	const accessible = accessibleAppNames ?? null;
	if (accessible === null) return apps;
	const byName = new Map(apps.map((app) => [app.name, app] as const));
	const visible = new Set<string>();
	for (const app of apps) {
		if (!appAccessAllowed(app.name, accessible)) continue;
		visible.add(app.name);
		for (const container of containersOf(app, byName)) visible.add(container);
	}
	return apps.filter((app) => visible.has(app.name));
};

export type ShellApp = AppDeclaration & {
	readonly icon?: string;
	/** `null` when the app declares none — distinct from "not yet normalised". */
	readonly description?: string | null;
	readonly thumbnail?: string | null;
	readonly banner?: string;
	readonly parent?: string;
	readonly defaultChild?: string;
};

const toApplicationItem = (
	app: ShellApp,
	input: {
		currentPath: string;
		i18n?: NavigationLabelResolver;
		childrenOf: ReadonlyMap<string, ReadonlyArray<ShellApp>>;
	}
): WorkspaceNavigationItem => {
	const children = (input.childrenOf.get(app.name) ?? []).map((child) =>
		toApplicationItem(child, input)
	);
	const landing =
		app.defaultChild === undefined
			? children[0]
			: (children.find(
					(child) =>
						child.key === `${app.name}/${app.defaultChild}` || child.key === app.defaultChild
				) ?? children[0]);
	const href = landing?.href ?? `/app/${app.name}`;
	return {
		key: app.name,
		label: resolveNavigationLabel(
			input.i18n,
			app.name,
			app.label || NavigationText.humanize(app.name)
		),
		icon: app.icon ?? 'lucide:layout-grid',
		href,
		active: isUnder(input.currentPath, href) || children.some((child) => child.active === true),
		featureColor: 'customApps',
		// The item type documents both of these as what the finder and the overview cards show, and
		// nothing set either — so every card printed "Open <label>" over the same placeholder gradient
		// while the workspace had published a description and a thumbnail for each one.
		...(app.description == null ? {} : { description: app.description }),
		...(app.thumbnail == null ? {} : { thumbnail: app.thumbnail }),
		...(children.length > 0 ? { children } : {})
	};
};

export const buildApplicationNavigation = (input: {
	apps: ReadonlyArray<ShellApp>;
	/**
	 * What `AccessControl.visibleApps` answered for this session, or `null`/absent when the host has
	 * no such list. Absent is unrestricted, not empty: a host that never asked must keep the sidebar
	 * it had, and a host that asked and got nothing back is saying something quite different.
	 */
	accessibleAppNames?: ReadonlyArray<string> | null;
	currentPath: string;
	i18n?: NavigationLabelResolver;
}): WorkspaceNavigationItem[] => {
	const declared = filterAccessibleApps(input.apps, input.accessibleAppNames);
	const names = new Set(declared.map((app) => app.name));
	const childrenOf = new Map<string, ShellApp[]>();
	for (const app of declared) {
		if (app.parent === undefined || !names.has(app.parent)) continue;
		const siblings = childrenOf.get(app.parent) ?? [];
		siblings.push(app);
		childrenOf.set(app.parent, siblings);
	}
	return declared
		.filter((app) => app.parent === undefined || !names.has(app.parent))
		.map((app) =>
			toApplicationItem(app, { currentPath: input.currentPath, i18n: input.i18n, childrenOf })
		);
};

export const buildSystemNavigation = (input: {
	plugins?: ReadonlyArray<HostPlugin>;
	isAdmin: boolean;
	currentPath: string;
	i18n?: NavigationLabelResolver;
}): WorkspaceNavigationItem[] => {
	const plugins = input.plugins ?? [];
	const visible = plugins.filter(
		(plugin) => plugin.placement !== 'footer' && (input.isAdmin || plugin.adminOnly !== true)
	);
	/*
	 * Every plugin entry wears a badge naming its provenance: a plugin is a surface the *host*
	 * provided, and the entry beside it — the workspace's own People page — is the tenant's own.
	 * The badge is the host's mark, drawn as an icon so it never truncates a label; a text pill
	 * measuring "Colony" once clipped "Environment secrets" in a 218px sidebar row.
	 */
	const pluginItem = (plugin: HostPlugin): WorkspaceNavigationItem => {
		const href = hostPluginSurfaceHref(plugin.key);
		return {
			key: plugin.key,
			label: plugin.label,
			icon: plugin.icon,
			href,
			active: isUnder(input.currentPath, href),
			badge: 'product:colony'
		};
	};
	const settingsChildren: WorkspaceNavigationItem[] = [
		...(input.isAdmin
			? [
					{
						key: 'workspace-people',
						label: input.i18n?.t('bolt.shell.people') ?? 'People',
						icon: 'lucide:users',
						href: WORKSPACE_SETTINGS_PATH,
						active: isUnder(input.currentPath, WORKSPACE_SETTINGS_PATH)
					} satisfies WorkspaceNavigationItem
				]
			: []),
		...visible.filter((plugin) => plugin.placement === 'settings').map(pluginItem)
	];
	const settings: WorkspaceNavigationItem[] =
		settingsChildren.length === 0
			? []
			: [
					{
						key: 'settings',
						label: input.i18n?.t('bolt.shell.settings') ?? 'Settings',
						icon: 'lucide:settings',
						href: settingsChildren[0]?.href ?? WORKSPACE_SETTINGS_PATH,
						active: settingsChildren.some((item) => item.active),
						children: settingsChildren
					}
				];
	return [
		...settings,
		...visible.filter((plugin) => plugin.placement !== 'settings').map(pluginItem)
	];
};

export const workspaceAuthorizesAgentSurface = (currentPath: string): boolean =>
	currentPath === AGENT_PATH;

/** Returns the host plugin whose surface matches the current path, or null. */
export const resolveHostPluginSurface = (
	currentPath: string,
	plugins: ReadonlyArray<{ readonly key: string; readonly entry: string }>
): { readonly key: string; readonly entry: string } | null =>
	plugins.find((plugin) => currentPath === hostPluginSurfaceHref(plugin.key)) ?? null;
