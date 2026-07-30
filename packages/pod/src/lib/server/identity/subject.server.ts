import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { createRecord, updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { UserRoleSchema, type TSeatCensus } from '@norbital-ai/platform-utils/system/types';

export type ResolvedSubject = {
	readonly userId: string;
	readonly created: boolean;
};

/** Billable seats: active humans only, so an agent user never appears on an invoice. */
export async function seatCensus(): Promise<TSeatCensus> {
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<{ role: string; seats: string }>({
		text: `SELECT role, COUNT(*)::text AS seats
		         FROM "user"
		        WHERE status = 'active' AND kind = 'human'
		        GROUP BY role`,
		values: []
	});
	const census: TSeatCensus = { admin: 0, advanced: 0, basic: 0 };
	const counts: Record<string, number> = { ...census };
	for (const row of result.rows) {
		// An unrecognized role is counted as `basic` rather than dropped: silently omitting a seat
		// under-bills, and a role that fell out of the enum is a migration defect, not a free seat.
		const role = UserRoleSchema.safeParse(row.role).success ? row.role : 'basic';
		counts[role] = (counts[role] ?? 0) + Number(row.seats);
	}
	return { admin: counts.admin ?? 0, advanced: counts.advanced ?? 0, basic: counts.basic ?? 0 };
}

/**
 * Publish one membership event for the host to drain.
 *
 * The census travels with the event rather than a delta. `host_event_outbox` is at-least-once, so a
 * redelivered "+1 seat" would double-bill; a snapshot applied twice is the same snapshot. `observed_at`
 * lets a host settle out-of-order delivery to the latest state.
 */
export async function emitMembershipEvent(input: {
	readonly reason:
		'invite_accepted' | 'user_removed' | 'user_deactivated' | 'user_reactivated' | 'role_changed';
	readonly subjectHmac: string | null;
}): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	await createRecord(
		ctx,
		'host_event_outbox',
		{
			event: 'membership.changed',
			reason: input.reason,
			subject_hmac: input.subjectHmac,
			seats: await seatCensus(),
			observed_at: new Date().toISOString()
		},
		{ isElevated: true }
	);
}

/**
 * Every member of this workspace, for a host rebuilding its routing index.
 *
 * Trusted-host only. It returns addresses because an index keyed on them is the point; the event
 * stream carries only digests, and this is the reconciliation path a host falls back to when that
 * stream has gaps.
 */
export async function workspaceMembership(): Promise<
	readonly { readonly email: string; readonly role: string; readonly status: string }[]
> {
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<{
		email: string;
		role: string | null;
		status: string | null;
	}>({
		text: `SELECT email, role, status FROM "user" WHERE kind = 'human' ORDER BY email`,
		values: []
	});
	return result.rows.map((row) => ({
		email: row.email,
		role: row.role ?? 'basic',
		status: row.status ?? 'active'
	}));
}

/**
 * Turn a provider-verified address into a workspace user.
 *
 * Three outcomes, and the ordering matters. An existing user is reused **without touching its role**:
 * a provider asserts identity, never privilege, so a returning `basic` user who was once invited as
 * `admin` must not be promoted by logging in. Otherwise a live invitation is redeemed — the update is
 * conditional on `consumed_at IS NULL`, so of two concurrent accepts exactly one wins and the loser
 * re-reads the user the winner created. With neither, the answer is `null` and the caller returns 403;
 * a verified address is not an entitlement.
 */
export async function resolveSubjectToUser(input: {
	readonly email: string;
	readonly displayName?: string;
	readonly subjectHmac: string | null;
}): Promise<ResolvedSubject | null> {
	const ctx = getWorkspace({ provision: true });
	const email = input.email.trim().toLowerCase();
	if (!email) return null;

	const existing = await ctx.tenantDb.query<{ norbital_id: string; status: string | null }>({
		text: `SELECT norbital_id, status FROM "user" WHERE lower(email) = $1 LIMIT 1`,
		values: [email]
	});
	const found = existing.rows[0];
	if (found) {
		if (found.status === 'inactive') return null;
		return { userId: found.norbital_id, created: false };
	}

	// Claim the invitation before creating the user. Claiming first means a lost race creates no
	// orphan user row; the winner is whichever UPDATE observes `consumed_at IS NULL`.
	const claimed = await ctx.tenantDb.query<{ norbital_id: string; role: string }>({
		text: `UPDATE invitation
		          SET consumed_at = now()
		        WHERE norbital_id = (
		                SELECT norbital_id FROM invitation
		                 WHERE lower(email) = $1
		                   AND consumed_at IS NULL
		                   AND expires_at > now()
		                 ORDER BY norbital_created_at
		                 LIMIT 1
		              )
		          AND consumed_at IS NULL
		    RETURNING norbital_id, role`,
		values: [email]
	});
	const invitation = claimed.rows[0];
	if (!invitation) {
		// Either there was never an invitation, or a concurrent accept took it. Re-read: if the winner
		// already created the user, this request is a legitimate login for that same person.
		const raced = await ctx.tenantDb.query<{ norbital_id: string }>({
			text: `SELECT norbital_id FROM "user" WHERE lower(email) = $1 LIMIT 1`,
			values: [email]
		});
		const winner = raced.rows[0];
		return winner ? { userId: winner.norbital_id, created: false } : null;
	}

	const role = UserRoleSchema.safeParse(invitation.role).success ? invitation.role : 'basic';
	const created = await createRecord(
		ctx,
		'user',
		{
			email,
			name: input.displayName ?? null,
			status: 'active',
			role,
			kind: 'human'
		},
		{ isElevated: true }
	);
	const userId = created.norbital_id;
	if (typeof userId !== 'string') throw new Error('Created user has no id');

	await updateRecord(
		ctx,
		'invitation',
		invitation.norbital_id,
		{ consumed_user_id: userId },
		{ isElevated: true }
	);
	await emitMembershipEvent({ reason: 'invite_accepted', subjectHmac: input.subjectHmac });
	return { userId, created: true };
}
