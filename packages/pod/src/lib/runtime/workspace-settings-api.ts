import { post } from './client.js';
import type { WorkspaceInvitation, WorkspaceSettingsApi } from './workspace-settings.js';

/**
 * The settings surface's transport.
 *
 * Invitations go to their own endpoints because `invitation` is client-opaque and must stay
 * unreachable from a replica. Teams go through `collections/admin/*`, which already writes the system
 * collections behind a server-side admin check — a second door onto the same table would only be
 * another place for that check to be forgotten.
 *
 * Separate from `workspace-settings.ts` so mounting the surface does not drag `client.ts`, and with it
 * the sync engine and PGlite, into a test about a list of members.
 */
export const workspaceSettingsApi: WorkspaceSettingsApi = {
	listInvitations: () => post<readonly WorkspaceInvitation[]>('settings/invitations', {}),
	invite: (input) =>
		post<{ invitationId: string; acceptPath: string; email: string }>(
			'settings/invitations/create',
			input
		),
	revokeInvitation: (invitationId) =>
		post<{ revoked: boolean }>('settings/invitations/revoke', { invitation_id: invitationId }),
	setMemberRole: (userId, role) => post('settings/members/role', { user_id: userId, role }),
	createTeam: (input) => post('collections/admin/create', { collection: 'team', input }),
	updateTeam: (teamId, input) =>
		post('collections/admin/update', {
			collection: 'team',
			record_id: teamId,
			input
		}),
	deleteTeam: (teamId) =>
		post('collections/admin/delete', { collection: 'team', record_id: teamId }),
	setTeamPolicy: (teamId, policyId) =>
		post('collections/admin/update', {
			collection: 'team',
			record_id: teamId,
			input: { policy_id: policyId }
		}),
	addTeamMember: (teamId, userId) =>
		post('collections/admin/create', {
			collection: 'team_members',
			input: { team_id: teamId, user_id: userId }
		}),
	removeTeamMember: (membershipId) =>
		post('collections/admin/delete', { collection: 'team_members', record_id: membershipId })
};
