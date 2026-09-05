import { Schema } from 'effect';
import { FeatureColorKeySchema } from '#lib/feature-colors';

export const WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS = 'text-overline';
export const WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS = 'text-xs font-normal sm:text-micro';
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
	readonly section?: 'operations' | 'administration' | 'settings';
	/**
	 * Ask before following this item. Set by builders for destinations that take over the
	 * session — a kiosk app renders chromeless, so the only way out is the URL bar — and the
	 * copy is the builder's, because only it knows what the destination does.
	 */
	readonly confirm?: {
		readonly title: string;
		readonly description: string;
		readonly confirmLabel: string;
		readonly cancelLabel: string;
	};
}

const WorkspaceNavigationConfirmSchema = Schema.Struct({
	title: Schema.String,
	description: Schema.String,
	confirmLabel: Schema.String,
	cancelLabel: Schema.String
});

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
	),
	section: Schema.optional(Schema.Literals(['operations', 'administration', 'settings'])),
	confirm: Schema.optional(WorkspaceNavigationConfirmSchema)
});

export interface WorkspaceNavigationSection {
	readonly key: 'operations' | 'administration' | 'applications';
	readonly label: string;
	readonly items: ReadonlyArray<WorkspaceNavigationItem>;
	readonly href?: string;
}

const WorkspaceNavigationSectionSchema = Schema.Struct({
	key: Schema.Literals(['operations', 'administration', 'applications']),
	label: Schema.String,
	items: Schema.Array(WorkspaceNavigationItemSchema),
	href: Schema.optional(Schema.String)
});

const WorkspaceImpersonationTeamSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.NullOr(Schema.String)
});
export type WorkspaceImpersonationTeam = typeof WorkspaceImpersonationTeamSchema.Type;

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
	sections: Schema.Array(WorkspaceNavigationSectionSchema),
	system: Schema.Array(WorkspaceNavigationItemSchema),
	applications: Schema.Array(WorkspaceNavigationItemSchema),
	applicationsHref: Schema.optional(Schema.String),
	utilities: Schema.optional(Schema.Array(WorkspaceNavigationItemSchema))
});
export type WorkspaceNavigationModel = typeof WorkspaceNavigationModelSchema.Type;
