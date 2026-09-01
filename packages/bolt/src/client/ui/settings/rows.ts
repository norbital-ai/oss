/**
 * What the workspace-access surfaces actually display.
 *
 * These were `ReadonlyArray<string>` — a member was a name, an invitation was an address, an audit
 * entry was a sentence. Everything the surfaces are for (who holds which role, whether an invitation
 * has expired, who changed what and when) had nowhere to live.
 */
import { Result, Schema } from 'effect';
import { WorkspaceAccess as WorkspaceAccessContract } from '@norbital-ai/bolt-protocol';

/**
 * The People surface's one payload: who is a member, which invitations are open, the distinct
 * teams those members carry, and the access events the runtime has recorded.
 */
export const WorkspaceAccessSchema = WorkspaceAccessContract;
export type WorkspaceAccess = typeof WorkspaceAccessSchema.Type;
export type MemberRow = WorkspaceAccess['members'][number];
export type InvitationRow = WorkspaceAccess['invitations'][number];
export type AuditRow = WorkspaceAccess['events'][number];
type MemberRole = MemberRow['role'];
type InvitationStatus = InvitationRow['status'];

export const EMPTY_WORKSPACE_ACCESS: WorkspaceAccess = {
	members: [],
	invitations: [],
	teams: [],
	events: []
};

export const decodeWorkspaceAccess = (value: unknown): WorkspaceAccess | undefined => {
	const decoded = Schema.decodeUnknownResult(WorkspaceAccessSchema)(value);
	return Result.isSuccess(decoded) ? decoded.success : undefined;
};

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
