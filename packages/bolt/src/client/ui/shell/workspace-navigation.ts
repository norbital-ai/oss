import { Result } from 'effect';
import type { ManifestDestination } from '@norbital-ai/bolt-protocol';
import type {
	WorkspaceNavigationItem,
	WorkspaceNavigationSection,
	WorkspaceOrganizationOption
} from '@norbital-ai/ui/workspace-shell';
import type { AppDeclaration } from '#lib/authoring/workspace-schema.js';

type NavigationLabelResolver = {
	has(key: string): boolean;
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};

type ShellMessageKey =
	| 'bolt.shell.people'
	| 'bolt.shell.settings'
	| 'bolt.shell.approvals'
	| 'bolt.shell.automations'
	| 'bolt.shell.operations'
	| 'bolt.shell.workspace'
	| 'bolt.shell.applications'
	| 'bolt.shell.more'
	| 'bolt.shell.documentation'
	| 'bolt.shell.kiosk'
	| 'bolt.shell.workspaceStudio'
	| 'bolt.shell.organization'
	| 'bolt.shell.agents'
	| 'bolt.shell.secrets';

export type HostPlugin = Readonly<{
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly entry: string;
	readonly placement?:
		'operations' | 'resources' | 'administration' | 'settings' | 'sidebar' | 'footer';
	readonly adminOnly?: boolean;
}>;

export const WORKSPACE_SETTINGS_PATH = '/people';
export const APPROVALS_PATH = '/approvals';
export const AUTOMATIONS_PATH = '/automations';
const HOST_PLUGIN_SURFACE_PREFIX = '/__host';
export const AGENT_PATH = '/agent';

const humanize = (value: string): string =>
	value.replaceAll(/[-_]/g, ' ').replaceAll(/\b\w/g, (character) => character.toUpperCase());

const hostPluginSurfaceHref = (pluginKey: string): string =>
	`${HOST_PLUGIN_SURFACE_PREFIX}/${encodeURIComponent(pluginKey)}`;

const ENVOYS_SETTINGS_PATH = hostPluginSurfaceHref('envoys');
const ENVIRONMENT_SETTINGS_PATH = hostPluginSurfaceHref('environment_secrets');

const applicationHref = (name: string): string => `/app/${name}`;

export const automationsHref = (selection?: string): string => {
	if (selection === undefined || selection === '') return AUTOMATIONS_PATH;
	return `${AUTOMATIONS_PATH}?${new URLSearchParams({ automation: selection }).toString()}`;
};

export const studioSourceHref = (sourcePath: string): string => {
	const query = new URLSearchParams({ source: sourcePath });
	return `${hostPluginSurfaceHref('workspace-studio')}?${query.toString()}`;
};

export const studioSourceFromSearch = (search: string): string | undefined => {
	const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
	const source = params.get('source')?.trim();
	return source === undefined || source === '' ? undefined : source;
};

export const manifestDestinationHref = (destination: ManifestDestination): string | null => {
	if (destination.kind === 'app') return applicationHref(destination.name);
	if (destination.surface === 'approvals') return APPROVALS_PATH;
	if (destination.surface === 'automations') return automationsHref(destination.selection);
	if (destination.surface === 'envoys') return ENVOYS_SETTINGS_PATH;
	if (destination.surface === 'environment') return ENVIRONMENT_SETTINGS_PATH;
	return null;
};

export const hostPluginKeyFromPath = (pathname: string): string | null => {
	const prefix = `${HOST_PLUGIN_SURFACE_PREFIX}/`;
	if (!pathname.startsWith(prefix)) return null;
	const raw = pathname.slice(prefix.length).split('/')[0] ?? '';
	if (raw.length === 0) return null;
	return Result.getOrElse(
		Result.try(() => decodeURIComponent(raw)),
		() => raw
	);
};

export const WORKSPACE_HOST_PLUGINS: ReadonlyArray<HostPlugin> = [
	{
		key: 'documentation',
		label: 'Documentation',
		icon: 'lucide:book-open',
		entry: hostPluginSurfaceHref('documentation'),
		placement: 'resources'
	},
	{
		key: 'organization',
		label: 'Organization',
		icon: 'lucide:building-2',
		entry: hostPluginSurfaceHref('organization'),
		placement: 'settings',
		adminOnly: true
	},
	{
		key: 'envoys',
		label: 'Envoys',
		icon: 'lucide:bot',
		entry: ENVOYS_SETTINGS_PATH,
		placement: 'settings',
		adminOnly: true
	},
	{
		key: 'environment_secrets',
		label: 'Environment secrets',
		icon: 'lucide:key-round',
		entry: hostPluginSurfaceHref('environment_secrets'),
		placement: 'settings',
		adminOnly: true
	},
	{
		key: 'workspace-studio',
		label: 'Workspace Studio',
		icon: 'product:studio',
		entry: hostPluginSurfaceHref('workspace-studio'),
		placement: 'settings',
		adminOnly: true
	}
];

const navigationTitleKeys = (id: string): ReadonlyArray<string> => {
	const leaf = id.includes('/') ? (id.slice(id.lastIndexOf('/') + 1) ?? id) : id;
	return [`app.${id}.title`, `app.${id.replaceAll('/', '.')}.title`, `app.${leaf}.title`];
};

const resolveNavigationLabel = (
	i18n: NavigationLabelResolver | undefined,
	id: string,
	fallback: string
): string => {
	if (i18n === undefined) return fallback;
	const key = navigationTitleKeys(id).find((candidate) => i18n.has(candidate));
	return key === undefined ? fallback : i18n.t(key);
};

const resolveShellLabel = (i18n: NavigationLabelResolver, key: ShellMessageKey): string =>
	i18n.t(key);

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

export const filterAccessibleApps = <App extends ShellApp>(
	apps: ReadonlyArray<App>,
	accessibleAppNames: ReadonlyArray<string> | null | undefined
): ReadonlyArray<App> => {
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

type ShellApp = AppDeclaration & {
	readonly icon?: string | undefined;
	readonly description?: string | null | undefined;
	readonly thumbnail?: string | null | undefined;
	readonly banner?: string | undefined;
	readonly parent?: string | undefined;
	readonly defaultChild?: string | undefined;
	readonly kiosk?: boolean | undefined;
};

type ApplicationNavigationInput = Readonly<{
	readonly apps: ReadonlyArray<ShellApp>;
	readonly accessibleAppNames?: ReadonlyArray<string> | null;
	readonly currentPath: string;
	readonly i18n?: NavigationLabelResolver;
}>;

type SystemNavigationInput = Readonly<{
	readonly plugins?: ReadonlyArray<HostPlugin>;
	readonly isAdmin: boolean;
	readonly canAccessAutomations?: boolean;
	readonly kiosk?: ReadonlyArray<WorkspaceNavigationItem>;
	readonly currentPath: string;
	readonly i18n: NavigationLabelResolver;
}>;

const toApplicationItem = (
	app: ShellApp,
	input: {
		currentPath: string;
		i18n?: NavigationLabelResolver | undefined;
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
	const href = landing?.href ?? applicationHref(app.name);
	return {
		key: app.name,
		label: resolveNavigationLabel(input.i18n, app.name, app.label || humanize(app.name)),
		icon: app.icon ?? 'lucide:layout-grid',
		href,
		active: isUnder(input.currentPath, href) || children.some((child) => child.active === true),
		featureColor: 'customApps',
		...(app.description == null ? {} : { description: app.description }),
		...(app.thumbnail == null ? {} : { thumbnail: app.thumbnail }),
		...(children.length > 0 ? { children } : {})
	};
};

export const buildApplicationNavigation = (
	input: ApplicationNavigationInput
): WorkspaceNavigationItem[] => {
	// Kiosk apps never appear among ordinary applications: they are device surfaces, not daily
	// tools, and they live in one collapsed Kiosk branch (`buildKioskNavigation`).
	const declared = filterAccessibleApps(
		input.apps.filter((app) => app.kiosk !== true),
		input.accessibleAppNames
	);
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
			toApplicationItem(app, {
				currentPath: input.currentPath,
				i18n: input.i18n,
				childrenOf
			})
		);
};

/**
 * The kiosk leaves under one secondary branch, each confirmed before it follows its href.
 *
 * A kiosk app is chromeless by declaration — no sidebar, finder or agent once mounted — so it is
 * not a thing a person uses from the LHS bar day to day. Grouping them under their parent app
 * buried them among the tools, and a bottom-level section of their own crowded the bar for a
 * surface most people never open; nesting them as one collapsed application branch keeps the bar
 * clean while keeping them findable, and each click is confirmed (the shell attaches the confirm copy)
 * because entering kiosk mode takes the whole window.
 */
export const buildKioskNavigation = (
	input: ApplicationNavigationInput
): WorkspaceNavigationItem[] => {
	const declared = filterAccessibleApps(
		input.apps.filter((app) => app.kiosk === true),
		input.accessibleAppNames
	);
	return declared.map((app) => ({
		key: app.name,
		label: resolveNavigationLabel(input.i18n, app.name, app.label || humanize(app.name)),
		icon: app.icon ?? 'lucide:scan-face',
		href: applicationHref(app.name),
		active: isUnder(input.currentPath, applicationHref(app.name)),
		featureColor: 'customApps',
		...(app.description == null ? {} : { description: app.description })
	}));
};

export const buildSystemNavigation = (input: SystemNavigationInput): WorkspaceNavigationItem[] => {
	const plugins = input.plugins ?? [];
	const visible = plugins.filter(
		(plugin) => plugin.placement !== 'footer' && (input.isAdmin || plugin.adminOnly !== true)
	);
	const pluginSection = (
		plugin: HostPlugin
	): 'operations' | 'resources' | 'administration' | 'settings' => {
		if (plugin.placement === 'operations') return 'operations';
		if (plugin.placement === 'resources') return 'resources';
		if (plugin.placement === 'settings') return 'settings';
		return 'administration';
	};
	const pluginItem = (plugin: HostPlugin): WorkspaceNavigationItem => {
		const href = hostPluginSurfaceHref(plugin.key);
		const labelKey: ShellMessageKey | undefined =
			plugin.key === 'documentation'
				? 'bolt.shell.documentation'
				: plugin.key === 'workspace-studio'
					? 'bolt.shell.workspaceStudio'
					: plugin.key === 'organization'
						? 'bolt.shell.organization'
						: plugin.key === 'envoys'
							? 'bolt.shell.agents'
							: plugin.key === 'environment_secrets'
								? 'bolt.shell.secrets'
								: undefined;
		return {
			key: plugin.key,
			label: labelKey === undefined ? plugin.label : resolveShellLabel(input.i18n, labelKey),
			icon: plugin.icon,
			href,
			active: isUnder(input.currentPath, href),
			badge: 'product:colony',
			section: pluginSection(plugin)
		};
	};
	const kioskChildren = input.kiosk ?? [];
	const kioskGroup: WorkspaceNavigationItem[] =
		kioskChildren.length === 0
			? []
			: [
					{
						key: 'kiosk',
						label: resolveShellLabel(input.i18n, 'bolt.shell.kiosk'),
						icon: 'lucide:scan-face',
						href: kioskChildren[0]?.href ?? WORKSPACE_SETTINGS_PATH,
						active: kioskChildren.some((item) => item.active),
						children: kioskChildren,
						section: 'resources'
					}
				];
	const settingsChildren: WorkspaceNavigationItem[] = [
		...(input.isAdmin
			? [
					{
						key: 'workspace-people',
						label: resolveShellLabel(input.i18n, 'bolt.shell.people'),
						icon: 'lucide:users',
						href: WORKSPACE_SETTINGS_PATH,
						active: isUnder(input.currentPath, WORKSPACE_SETTINGS_PATH),
						section: 'settings'
					} satisfies WorkspaceNavigationItem
				]
			: []),
		...visible.filter((plugin) => pluginSection(plugin) === 'settings').map(pluginItem)
	];
	const settings: WorkspaceNavigationItem[] =
		settingsChildren.length === 0
			? []
			: [
					{
						key: 'settings',
						label: resolveShellLabel(input.i18n, 'bolt.shell.settings'),
						icon: 'lucide:settings',
						href: settingsChildren[0]?.href ?? WORKSPACE_SETTINGS_PATH,
						active: settingsChildren.some((item) => item.active),
						children: settingsChildren,
						section: 'administration'
					}
				];
	return [
		...settings,
		{
			key: 'approvals',
			label: resolveShellLabel(input.i18n, 'bolt.shell.approvals'),
			icon: 'lucide:shield-check',
			href: APPROVALS_PATH,
			active: isUnder(input.currentPath, APPROVALS_PATH),
			section: 'operations'
		},
		...(input.canAccessAutomations === true
			? [
					{
						key: 'automations',
						label: resolveShellLabel(input.i18n, 'bolt.shell.automations'),
						icon: 'product:automations',
						href: AUTOMATIONS_PATH,
						active: isUnder(input.currentPath, AUTOMATIONS_PATH),
						section: 'operations'
					} satisfies WorkspaceNavigationItem
				]
			: []),
		...visible.filter((plugin) => pluginSection(plugin) !== 'settings').map(pluginItem),
		...kioskGroup
	];
};

const namedSection = (
	key: WorkspaceNavigationSection['key'],
	label: string,
	items: ReadonlyArray<WorkspaceNavigationItem>,
	href?: string
): WorkspaceNavigationSection[] =>
	items.length === 0 ? [] : [{ key, label, items, ...(href === undefined ? {} : { href }) }];

export const buildWorkspaceNavigationSections = (input: {
	readonly system: ReadonlyArray<WorkspaceNavigationItem>;
	readonly applications: ReadonlyArray<WorkspaceNavigationItem>;
	readonly applicationsHref?: string | undefined;
	readonly i18n: NavigationLabelResolver;
}): WorkspaceNavigationSection[] => {
	const resources = input.system.filter((item) => item.section === 'resources');
	const more: WorkspaceNavigationItem[] =
		resources.length === 0
			? []
			: [
					{
						key: 'more',
						label: resolveShellLabel(input.i18n, 'bolt.shell.more'),
						icon: 'lucide:ellipsis',
						href: resources[0]?.href ?? WORKSPACE_SETTINGS_PATH,
						active: resources.some((item) => item.active),
						children: resources
					}
				];
	return [
		...namedSection(
			'applications',
			resolveShellLabel(input.i18n, 'bolt.shell.applications'),
			[...input.applications, ...input.system.filter((item) => item.section === 'applications')],
			input.applicationsHref
		),
		...namedSection(
			'operations',
			resolveShellLabel(input.i18n, 'bolt.shell.operations'),
			input.system.filter((item) => item.section === 'operations')
		),
		...namedSection('workspace', resolveShellLabel(input.i18n, 'bolt.shell.workspace'), [
			...more,
			...input.system.filter((item) => item.section === 'administration')
		])
	];
};

export const resolveHostPluginSurface = (
	currentPath: string,
	plugins: ReadonlyArray<{ readonly key: string; readonly entry: string }>
): { readonly key: string; readonly entry: string } | null =>
	plugins.find((plugin) => currentPath === hostPluginSurfaceHref(plugin.key)) ?? null;
