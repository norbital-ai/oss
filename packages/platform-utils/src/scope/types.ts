import { z } from 'zod';
import { UserRoleSchema, UserStatusSchema } from '../system/types.js';

export type TNorbitalDBRecord = Record<string, unknown> & { norbital_id: string };

/** Wire shape for a team member in execution scope (no DB audit columns). */
export const ScopeTeamMemberSchema = z.object({
	norbital_id: z.string(),
	name: z.string().nullable(),
	description: z.string().nullable(),
	parent_id: z.string().nullable(),
	is_active: z.boolean().nullable()
});
export type TScopeTeamMember = z.infer<typeof ScopeTeamMemberSchema>;

/**
 * Where a stored `document_asset` is served from.
 *
 * Per segment, because the key is a path and the download route is a rest parameter: encoding the
 * whole key would turn its separators into `%2F` and leave the route to guess whether it was given
 * one segment or several.
 */
export function documentAssetDownloadUrl(storageKey: string): string {
	return `/api/files/download/${storageKey.split('/').map(encodeURIComponent).join('/')}`;
}

/** Requestor carried over HTTP headers between Core and the runtime isolate. */
export const UserInfoSchema = z.object({
	norbital_id: z.string(),
	user_name: z.string(),
	email: z.string(),
	role: UserRoleSchema,
	user_status: UserStatusSchema,
	team_members: z.array(ScopeTeamMemberSchema),
	/**
	 * The requestor's avatar, already resolved to something an `<img>` can load.
	 *
	 * A URL rather than the `user.avatar_asset_id` it is derived from, because the shell that
	 * renders it is a presentation component with no collection client to resolve an asset id
	 * with — and resolving it here keeps a host that has a provider-supplied avatar URL, and one
	 * that has an uploaded asset, sending the same field.
	 */
	avatar_url: z.string().nullable(),
	deactivated_at: z.string().nullable()
});
export type TScopeRequestor = z.infer<typeof UserInfoSchema>;
export type TUserInfo = z.infer<typeof UserInfoSchema>;

export const ScopeOrganizationSchema = z.object({
	norbital_id: z.string(),
	name: z.string()
});
export type TScopeOrganization = z.infer<typeof ScopeOrganizationSchema>;

export const BaseScopeSchema = z.object({
	requestor: UserInfoSchema,
	organization: ScopeOrganizationSchema
});
export type TBaseScope = z.infer<typeof BaseScopeSchema>;
