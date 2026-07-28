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
