/**
 * Tenant directory reads the host can run without admitting a guest.
 *
 * The SQL is the same the guest used for `seats` / `membership` / `invite-email`. Guest wrappers
 * still call these during `resolve-subject` (which stays a named guest function).
 */
import { UserRoleSchema, type TSeatCensus } from '@norbital-ai/platform-utils/system/types';

export type HostDirectoryDb = {
	query(
		sql: string,
		params?: readonly unknown[]
	): Promise<{ readonly rows: readonly unknown[]; readonly rowCount?: number }>;
};

/** Billable seats: active humans only, so an agent user never appears on an invoice. */
export async function seatCensusOnDb(db: HostDirectoryDb): Promise<TSeatCensus> {
	const result = await db.query(
		`SELECT role, COUNT(*)::text AS seats
		   FROM "user"
		  WHERE status = 'active' AND kind = 'human'
		  GROUP BY role`
	);
	const census: TSeatCensus = { admin: 0, advanced: 0, basic: 0 };
	const counts: Record<string, number> = { ...census };
	for (const row of result.rows as readonly { role: string; seats: string }[]) {
		const role = UserRoleSchema.safeParse(row.role).success ? row.role : 'basic';
		counts[role] = (counts[role] ?? 0) + Number(row.seats);
	}
	return { admin: counts.admin ?? 0, advanced: counts.advanced ?? 0, basic: counts.basic ?? 0 };
}

/**
 * Every human member of this workspace, for a host rebuilding its routing index.
 */
export async function workspaceMembershipOnDb(
	db: HostDirectoryDb
): Promise<readonly { readonly email: string; readonly role: string; readonly status: string }[]> {
	const result = await db.query(
		`SELECT email, role, status FROM "user" WHERE kind = 'human' ORDER BY email`
	);
	return (
		result.rows as readonly {
			email: string;
			role: string | null;
			status: string | null;
		}[]
	).map((row) => ({
		email: row.email,
		role: row.role ?? 'basic',
		status: row.status ?? 'active'
	}));
}

/**
 * Look up the address a token belongs to, without consuming it.
 */
export async function inviteeEmailForTokenOnDb(
	db: HostDirectoryDb,
	tokenHash: string
): Promise<string | null> {
	const result = await db.query(
		`SELECT email FROM invitation
		  WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
		  LIMIT 1`,
		[tokenHash]
	);
	const row = result.rows[0] as { email: string } | undefined;
	return row?.email ?? null;
}
