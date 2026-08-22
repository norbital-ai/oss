import { Schema } from 'effect';
import { FeatureColorKeySchema } from '#lib/feature-colors';

/**
 * A sidebar section heading is the `text-overline` role and nothing more, so the constant
 * is now the role class rather than a fourth private assembly of size, weight, transform
 * and tracking. It stays a named export because the workspace sidebar applies it in three
 * places that are not `Sidebar.GroupLabel`.
 */
export const WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS = 'text-overline';
export const WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS = 'text-xs font-normal sm:text-micro';
/** Shared right-edge slot for expand chevrons and host-plugin badges. */
export const WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS =
	'pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center justify-center';

const WorkspaceOrganizationOptionSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	logoUrl: Schema.optional(Schema.NullOr(Schema.String))
});
export type WorkspaceOrganizationOption = typeof WorkspaceOrganizationOptionSchema.Type;

const WorkspaceUserSummarySchema = Schema.Struct({
	name: Schema.String,
	email: Schema.String,
	role: Schema.String,
	avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
	teamLabels: Schema.Array(Schema.String)
});
export type WorkspaceUserSummary = typeof WorkspaceUserSummarySchema.Type;

export interface WorkspaceNavigationItem {
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly href: string;
	readonly active: boolean;
	readonly badge?: string;
	readonly featureColor?: typeof FeatureColorKeySchema.Type;
	readonly description?: string | null;
	readonly thumbnail?: string | null;
	readonly children?: ReadonlyArray<WorkspaceNavigationItem>;
}

const WorkspaceNavigationItemSchema: Schema.Codec<WorkspaceNavigationItem> = Schema.Struct({
	key: Schema.String,
	label: Schema.String,
	icon: Schema.NullOr(Schema.String),
	href: Schema.String,
	active: Schema.Boolean,
	badge: Schema.optional(Schema.String),
	featureColor: Schema.optional(FeatureColorKeySchema),
	description: Schema.optional(Schema.NullOr(Schema.String)),
	thumbnail: Schema.optional(Schema.NullOr(Schema.String)),
	children: Schema.optional(
		Schema.Array(
			Schema.suspend((): Schema.Codec<WorkspaceNavigationItem> => WorkspaceNavigationItemSchema)
		)
	)
});

/** A team a workspace admin can preview the workspace under. */
const WorkspaceImpersonationTeamSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.NullOr(Schema.String)
});
export type WorkspaceImpersonationTeam = typeof WorkspaceImpersonationTeamSchema.Type;

/**
 * Admin team impersonation state for the account menu.
 *
 * The shell renders the picker only when the host supplies the data; the host
 * decides who qualifies (admins only) and what teams exist.
 */
const WorkspaceImpersonationSchema = Schema.Struct({
	isAdmin: Schema.Boolean,
	isActive: Schema.Boolean,
	activeTeamIds: Schema.Array(Schema.String),
	teams: Schema.Array(WorkspaceImpersonationTeamSchema)
});
export type WorkspaceImpersonation = typeof WorkspaceImpersonationSchema.Type;

type WorkspaceNavigationBranchParams = {
	open: boolean;
	href: string;
	expanded: boolean;
	onNavigate?: (href: string) => void;
};

export function toggleWorkspaceNavigationBranch(params: WorkspaceNavigationBranchParams): boolean {
	const { open, href, expanded, onNavigate } = params;
	if (!open) {
		onNavigate?.(href);
		return expanded;
	}
	return !expanded;
}

const WorkspaceNavigationModelSchema = Schema.Struct({
	activeOrganization: WorkspaceOrganizationOptionSchema,
	organizations: Schema.Array(WorkspaceOrganizationOptionSchema),
	user: WorkspaceUserSummarySchema,
	system: Schema.Array(WorkspaceNavigationItemSchema),
	applications: Schema.Array(WorkspaceNavigationItemSchema),
	/** Optional destination for the Applications section label, such as an app directory. */
	applicationsHref: Schema.optional(Schema.String),
	/** Compact account-adjacent tools, rendered above notifications in the sidebar footer. */
	utilities: Schema.optional(Schema.Array(WorkspaceNavigationItemSchema))
});
export type WorkspaceNavigationModel = typeof WorkspaceNavigationModelSchema.Type;
