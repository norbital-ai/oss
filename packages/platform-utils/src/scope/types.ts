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

/** Requestor carried over HTTP headers between Core and the runtime isolate. */
export const UserInfoSchema = z.object({
	norbital_id: z.string(),
	user_name: z.string(),
	email: z.string(),
	role: UserRoleSchema,
	user_status: UserStatusSchema,
	team_members: z.array(ScopeTeamMemberSchema),
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
