import type { FeatureColorKey } from '../feature-colors/index.js';

export const WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS =
	'text-micro font-normal uppercase tracking-wide sm:text-tiny';
export const WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS = 'text-xs font-normal sm:text-micro';

export interface WorkspaceOrganizationOption {
	readonly id: string;
	readonly name: string;
	readonly logoUrl?: string | null;
}

export interface WorkspaceUserSummary {
	readonly name: string;
	readonly email: string;
	readonly role: string;
	readonly avatarUrl?: string | null;
	readonly teamLabels: readonly string[];
}

export interface WorkspaceNavigationItem {
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly href: string;
	readonly active: boolean;
	/** Compact provenance label for a host-supplied navigation surface. */
	readonly badge?: string;
	readonly featureColor?: FeatureColorKey;
	readonly children?: readonly WorkspaceNavigationItem[];
}

/** A team a workspace admin can preview the workspace under. */
export interface WorkspaceImpersonationTeam {
	readonly id: string;
	readonly name: string | null;
}

/**
 * Admin team impersonation state for the account menu.
 *
 * The shell renders the picker only when the host supplies the data; the host
 * decides who qualifies (admins only) and what teams exist.
 */
export interface WorkspaceImpersonation {
	readonly isAdmin: boolean;
	readonly isActive: boolean;
	readonly activeTeamIds: readonly string[];
	readonly teams: readonly WorkspaceImpersonationTeam[];
}

export function toggleWorkspaceNavigationBranch({
	open,
	href,
	expanded,
	onNavigate
}: {
	open: boolean;
	href: string;
	expanded: boolean;
	onNavigate?: (href: string) => void;
}): boolean {
	if (!open) {
		onNavigate?.(href);
		return expanded;
	}
	return !expanded;
}

export interface WorkspaceNavigationModel {
	readonly activeOrganization: WorkspaceOrganizationOption;
	readonly organizations: readonly WorkspaceOrganizationOption[];
	readonly user: WorkspaceUserSummary;
	readonly system: readonly WorkspaceNavigationItem[];
	readonly applications: readonly WorkspaceNavigationItem[];
	/** Compact account-adjacent tools, rendered above notifications in the sidebar footer. */
	readonly utilities?: readonly WorkspaceNavigationItem[];
}
