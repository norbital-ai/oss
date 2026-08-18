/**
 * What the workspace-access surfaces actually display.
 *
 * These were `ReadonlyArray<string>` — a member was a name, an invitation was an address, an audit
 * entry was a sentence. Everything the surfaces are for (who holds which role, whether an invitation
 * has expired, who changed what and when) had nowhere to live.
 */

export type MemberRole = 'admin' | 'manager' | 'basic';
export type MemberStatus = 'active' | 'suspended' | 'invited';

export type MemberRow = Readonly<{
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly role: MemberRole;
	readonly status: MemberStatus;
	readonly teams?: ReadonlyArray<string>;
}>;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type InvitationRow = Readonly<{
	readonly id: string;
	readonly email: string;
	readonly role: MemberRole;
	readonly status: InvitationStatus;
	readonly invitedBy?: string;
	/** ISO instant; absent when the invitation never expires. */
	readonly expiresAt?: string;
}>;

export type AuditRow = Readonly<{
	readonly id: string;
	readonly action: string;
	readonly actor: string;
	readonly subject?: string;
	/** ISO instant. */
	readonly at: string;
}>;

/**
 * An invitation is expired once its deadline has passed, whatever the stored status says.
 * The row is written when the invitation is created and nothing revisits it afterwards, so a
 * `pending` row with a past deadline is the normal case, not a data error.
 */
export const invitationStatusAt = (invitation: InvitationRow, now: Date): InvitationStatus => {
	if (invitation.status !== 'pending') return invitation.status;
	if (invitation.expiresAt === undefined) return 'pending';
	const expiry = Date.parse(invitation.expiresAt);
	if (Number.isNaN(expiry)) return 'pending';
	return expiry <= now.getTime() ? 'expired' : 'pending';
};

/** Only a pending invitation can still be revoked or resent. */
export const isActionableInvitation = (invitation: InvitationRow, now: Date): boolean =>
	invitationStatusAt(invitation, now) === 'pending';

/** Members sort by role seniority, then by display name, so admins are never buried in a long list. */
const ROLE_ORDER: Readonly<Record<MemberRole, number>> = { admin: 0, manager: 1, basic: 2 };

export const sortMembers = (members: ReadonlyArray<MemberRow>): ReadonlyArray<MemberRow> =>
	[...members].sort(
		(left, right) =>
			ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
			(left.name || left.email).localeCompare(right.name || right.email)
	);

/** Audit entries read newest first; an unparseable timestamp sorts last rather than throwing. */
export const sortAudit = (events: ReadonlyArray<AuditRow>): ReadonlyArray<AuditRow> =>
	[...events].sort((left, right) => {
		const leftAt = Date.parse(left.at);
		const rightAt = Date.parse(right.at);
		if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) return 0;
		if (Number.isNaN(leftAt)) return 1;
		if (Number.isNaN(rightAt)) return -1;
		return rightAt - leftAt;
	});

/** Renders a member's display label without falling back to an empty cell. */
export const memberLabel = (member: MemberRow): string => member.name || member.email;
