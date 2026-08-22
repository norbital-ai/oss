/**
 * What the workspace-access surfaces actually display.
 *
 * These were `ReadonlyArray<string>` — a member was a name, an invitation was an address, an audit
 * entry was a sentence. Everything the surfaces are for (who holds which role, whether an invitation
 * has expired, who changed what and when) had nowhere to live.
 */
import { Schema } from 'effect';
import { TeamNodeSchema } from '#lib/client/ui/settings/team-hierarchy.js';

const MemberRoleSchema = Schema.Literals(['admin', 'manager', 'basic']);
type MemberRole = typeof MemberRoleSchema.Type;
const MemberStatusSchema = Schema.Literals(['active', 'suspended', 'invited']);

const MemberRowSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	name: Schema.String,
	role: MemberRoleSchema,
	status: MemberStatusSchema,
	/**
	 * The one team this person belongs to, absent for somebody nobody has placed.
	 *
	 * Singular, because `bolt_auth_user.team_id` is one team and the projection reports one name.
	 * This was a `teams` array, and nothing ever filled it: `workspaceAccess` answers `team`, so the
	 * decoder read a key that is not on the wire, every member rendered with an em dash, and the
	 * surface said the workspace had nobody on any team.
	 */
	team: Schema.optionalKey(Schema.String)
});
export type MemberRow = typeof MemberRowSchema.Type;

const InvitationStatusSchema = Schema.Literals(['pending', 'accepted', 'revoked', 'expired']);
type InvitationStatus = typeof InvitationStatusSchema.Type;

const InvitationRowSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	role: MemberRoleSchema,
	status: InvitationStatusSchema,
	invitedBy: Schema.optionalKey(Schema.String),
	/** ISO instant; absent when the invitation never expires. */
	expiresAt: Schema.optionalKey(Schema.String)
});
export type InvitationRow = typeof InvitationRowSchema.Type;

const AuditRowSchema = Schema.Struct({
	id: Schema.String,
	action: Schema.String,
	actor: Schema.String,
	subject: Schema.optionalKey(Schema.String),
	/** ISO instant. */
	at: Schema.String
});
export type AuditRow = typeof AuditRowSchema.Type;

/**
 * The People surface's one payload: who is a member, which invitations are open, the distinct
 * teams those members carry, and the access events the runtime has recorded.
 */
export const WorkspaceAccessSchema = Schema.Struct({
	members: Schema.Array(MemberRowSchema),
	invitations: Schema.Array(InvitationRowSchema),
	teams: Schema.Array(TeamNodeSchema),
	events: Schema.Array(AuditRowSchema)
});

export type WorkspaceAccess = typeof WorkspaceAccessSchema.Type;

export const EMPTY_WORKSPACE_ACCESS: WorkspaceAccess = {
	members: [],
	invitations: [],
	teams: [],
	events: []
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
