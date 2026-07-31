/**
 * Identity and access administration, owned by Pod.
 *
 * A workspace has to be administrable by the people in it, whatever is hosting it — a pod started
 * with `pod start` has no host plugins at all, so a settings surface that lived in the host would
 * leave a standalone workspace with no way to add a second person to itself.
 *
 * Users, teams and policies are ordinary replicated collections and are read through the collection
 * client like anything else. Invitations are not, and cannot be: `invitation` is client-opaque
 * (`CLIENT_OPAQUE_COLLECTIONS`) because every row carries the digest of a redeemable credential, and
 * that denial is enforced in the permission guard, in the replica DDL and in the sync stream. So the
 * invitation half of this surface is these endpoints, which project the four fields an administrator
 * actually needs and never select `token_hash` at all.
 *
 * Every function here authorizes as workspace admin *on the server*. Hiding the sidebar entry is a
 * presentation choice; the URL and the endpoint are reachable by any signed-in session, and inviting
 * a user or changing a role is exactly the surface a non-admin would use to promote themselves.
 */
import { UserRoleSchema } from '@norbital-ai/platform-utils/system/types';
import { error } from '$lib/runtime/http.js';
import { ensureOrganizationAdmin, getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { deleteRecord, updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { mintInvitation } from './invitation.server.js';
import { z } from 'zod';

export const InviteMemberSchema = z.object({
	email: z.string().trim().min(1).max(320),
	role: UserRoleSchema.default('basic')
});
export const RevokeInvitationSchema = z.object({ invitation_id: z.string().uuid() });
export const SetMemberRoleSchema = z.object({
	user_id: z.string().uuid(),
	role: UserRoleSchema
});

/** An invitation as an administrator may see it. Deliberately not the row. */
export type WorkspaceInvitationSummary = {
	readonly norbital_id: string;
	readonly email: string;
	readonly role: string;
	readonly status: 'pending' | 'accepted' | 'expired';
	readonly created_at: string;
	readonly expires_at: string;
};

function invitationStatus(row: {
	consumed_at: string | null;
	expires_at: string;
}): WorkspaceInvitationSummary['status'] {
	if (row.consumed_at) return 'accepted';
	return Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'pending';
}

/**
 * Every invitation, projected.
 *
 * The column list is the disclosure boundary: `token_hash` is not selected, so no later change to how
 * this result is shaped can leak it. `consumed_at` is read only to derive a status and does not
 * survive into the response.
 */
export async function listWorkspaceInvitations(): Promise<readonly WorkspaceInvitationSummary[]> {
	ensureOrganizationAdmin('Only workspace admins can see invitations');
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<{
		norbital_id: string;
		email: string;
		role: string;
		created_at: string;
		expires_at: string;
		consumed_at: string | null;
	}>({
		text: `SELECT norbital_id::text AS norbital_id,
		              email,
		              role,
		              norbital_created_at::text AS created_at,
		              expires_at::text AS expires_at,
		              consumed_at::text AS consumed_at
		         FROM invitation
		        ORDER BY norbital_created_at DESC`,
		values: []
	});
	return result.rows.map((row) => ({
		norbital_id: row.norbital_id,
		email: row.email,
		role: row.role,
		status: invitationStatus(row),
		created_at: row.created_at,
		expires_at: row.expires_at
	}));
}

/**
 * Invite an address, and hand the link back to the administrator who asked.
 *
 * The plaintext token exists in exactly one place — this response — so the caller is the one who
 * delivers it. Nothing is logged and nothing is persisted but the digest.
 *
 * Returns an **origin-relative** path, and the browser composes the absolute link. This used to
 * demand the origin from the host over a header, which meant the workspace could not mint an
 * invitation under a host that had not been taught to send one. The header was answering a question
 * the caller already knew the answer to: the administrator is looking at this workspace right now, so
 * their `location.origin` is by definition an origin that reaches it — more reliably than a
 * configured value, which can be stale, or wrong behind a custom domain.
 *
 * Nothing is trusted from the client either way. The path is built here from a token minted here; the
 * client only prefixes where it already is. A caller who lies to itself about its own origin gets a
 * link it cannot use, which is not an attack on anyone else.
 */
export async function inviteWorkspaceMember(
	input: z.infer<typeof InviteMemberSchema>
): Promise<{ readonly invitationId: string; readonly acceptPath: string; readonly email: string }> {
	ensureOrganizationAdmin('Only workspace admins can invite people');
	const email = input.email.trim().toLowerCase();
	const invitedBy = getWorkspace({ provision: true }).baseScope.requestor.norbital_id;
	const minted = await mintInvitation({
		email,
		role: input.role,
		invitedByUserId: invitedBy
	});
	return { ...minted, email };
}

/**
 * Withdraw an invitation that has not been redeemed.
 *
 * A consumed invitation is left alone: it is the record of how an existing user got in, and deleting
 * it would neither remove that user nor take anything back.
 */
export async function revokeWorkspaceInvitation(
	input: z.infer<typeof RevokeInvitationSchema>
): Promise<{ readonly revoked: boolean }> {
	ensureOrganizationAdmin('Only workspace admins can revoke invitations');
	const ctx = getWorkspace({ provision: true });
	const live = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `SELECT norbital_id FROM invitation WHERE norbital_id = $1::uuid AND consumed_at IS NULL`,
		values: [input.invitation_id]
	});
	if (!live.rows[0]) return { revoked: false };
	await deleteRecord(ctx, 'invitation', input.invitation_id, { isElevated: true });
	return { revoked: true };
}

/**
 * Change what a member may do.
 *
 * Written through the ordinary record path (elevated) rather than as raw SQL, so the change reaches
 * every open replica the way any other write does.
 *
 * The last admin cannot be demoted. Not a courtesy: role is the only thing that opens this surface,
 * so a workspace whose final admin demotes themselves has no one who can undo it, and on a
 * self-hosted pod there is no support desk behind it.
 */
export async function setWorkspaceMemberRole(
	input: z.infer<typeof SetMemberRoleSchema>
): Promise<{ readonly norbital_id: string; readonly role: string }> {
	ensureOrganizationAdmin('Only workspace admins can change roles');
	const ctx = getWorkspace({ provision: true });
	if (input.role !== 'admin') {
		const admins = await ctx.tenantDb.query<{ norbital_id: string }>({
			text: `SELECT norbital_id FROM "user"
			        WHERE role = 'admin' AND status = 'active' AND norbital_id <> $1::uuid
			        LIMIT 1`,
			values: [input.user_id]
		});
		if (!admins.rows[0]) {
			throw error(409, 'A workspace must keep at least one admin.');
		}
	}
	await updateRecord(ctx, 'user', input.user_id, { role: input.role }, { isElevated: true });
	return { norbital_id: input.user_id, role: input.role };
}
