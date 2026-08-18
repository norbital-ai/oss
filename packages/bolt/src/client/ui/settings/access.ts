import type { AuditRow, InvitationRow, MemberRow } from './rows.js';
import type { TeamNode } from './team-hierarchy.js';

/**
 * The People surface's one payload: who is a member, which invitations are open, the distinct
 * teams those members carry, and the access events the runtime has recorded.
 */
export type WorkspaceAccess = Readonly<{
	readonly members: ReadonlyArray<MemberRow>;
	readonly invitations: ReadonlyArray<InvitationRow>;
	readonly teams: ReadonlyArray<TeamNode>;
	readonly events: ReadonlyArray<AuditRow>;
}>;

export const EMPTY_WORKSPACE_ACCESS: WorkspaceAccess = {
	members: [],
	invitations: [],
	teams: [],
	events: []
};
