/**
 * What the settings surface renders, and the contract it renders it through.
 *
 * Deliberately free of imports that reach the transport: the concrete client lives in
 * `workspace-settings-api.ts`, because `runtime/client.ts` pulls in the whole sync engine (and with it
 * PGlite) and this module is what a component test mounts the surface against.
 */
import type { TUserRole } from '@norbital-ai/platform-utils/system/types';
import type { WorkspaceInvitation } from '$lib/shared/workspace-invitation.js';
import type { user } from '@norbital-ai/platform-utils/system/workspace-schema';

export type { WorkspaceInvitation };

/**
 * The writes and the one read the settings surface cannot take from the replica.
 *
 * Declared as a type rather than reached for directly so the surface can be mounted against a stand-in
 * — there is no server in a component test, and a settings page that could only be exercised through
 * one would not be exercised.
 */
export type WorkspaceSettingsApi = {
	listInvitations(): Promise<readonly WorkspaceInvitation[]>;
	invite(input: {
		email: string;
		role: TUserRole;
	}): Promise<{ invitationId: string; acceptPath: string; email: string }>;
	revokeInvitation(invitationId: string): Promise<{ revoked: boolean }>;
	setMemberRole(userId: string, role: TUserRole): Promise<unknown>;
	createTeam(input: {
		name: string;
		description?: string | null;
		parent_id?: string | null;
		policy_id?: string | null;
	}): Promise<unknown>;
	updateTeam(
		teamId: string,
		input: {
			name: string;
			description?: string | null;
			parent_id?: string | null;
			policy_id?: string | null;
		}
	): Promise<unknown>;
	deleteTeam(teamId: string): Promise<unknown>;
	setTeamPolicy(teamId: string, policyId: string | null): Promise<unknown>;
	addTeamMember(teamId: string, userId: string): Promise<unknown>;
	removeTeamMember(membershipId: string): Promise<unknown>;
};

/**
 * What the settings surface renders, and how a replica row becomes it.
 *
 * `user`, `team` and `policy` are ordinary replicated collections, so their rows arrive from a local
 * SQL replica whose columns were introspected at runtime. "It has an email" is therefore a fact to
 * read rather than one to assert, and a row missing what a line needs is dropped instead of rendered
 * as a row of `undefined`.
 */
export type MemberRow = Pick<
	typeof user.$inferSelect,
	'norbital_id' | 'email' | 'name' | 'role' | 'status'
>;

export type TeamRow = {
	readonly norbital_id: string;
	readonly name: string;
	readonly description: string | null;
	readonly parent_id: string | null;
	readonly policy_id: string | null;
};

export type PolicyRow = {
	readonly norbital_id: string;
	readonly key: string;
	readonly name: string;
	readonly description: string | null;
	readonly is_active: boolean;
	readonly accessible_applications: readonly string[];
	readonly grants: readonly unknown[];
};

/** Reads a string field from a replica row, or null when the column is missing. */
// stupidity:allow Q4 -- named helper
function text(record: Readonly<Record<string, unknown>>, field: string): string | null {
	const value = record[field];
	return typeof value === 'string' ? value : null;
}

/** Drops a user row that lacks an id or email rather than rendering undefined. */
export function toMemberRow(record: Readonly<Record<string, unknown>>): MemberRow[] {
	const id = text(record, 'norbital_id');
	const email = text(record, 'email');
	if (!id || !email) return [];
	return [
		{
			norbital_id: id,
			email,
			name: text(record, 'name') ?? '',
			role: text(record, 'role') ?? 'basic',
			status: text(record, 'status') ?? 'active'
		}
	];
}

/** Drops a team row that lacks an id or name rather than rendering undefined. */
export function toTeamRow(record: Readonly<Record<string, unknown>>): TeamRow[] {
	const id = text(record, 'norbital_id');
	const name = text(record, 'name');
	if (!id || !name) return [];
	return [
		{
			norbital_id: id,
			name,
			description: text(record, 'description'),
			parent_id: text(record, 'parent_id'),
			policy_id: text(record, 'policy_id')
		}
	];
}

/** Drops a policy row that lacks an id or name rather than rendering undefined. */
export function toPolicyRow(record: Readonly<Record<string, unknown>>): PolicyRow[] {
	const id = text(record, 'norbital_id');
	const name = text(record, 'name');
	if (!id || !name) return [];
	return [
		{
			norbital_id: id,
			key: text(record, 'key') ?? name,
			name,
			description: text(record, 'description'),
			is_active: record.is_active !== false,
			accessible_applications: Array.isArray(record.accessible_applications)
				? record.accessible_applications.filter(
						(value): value is string => typeof value === 'string'
					)
				: [],
			grants: Array.isArray(record.grants) ? record.grants : []
		}
	];
}

export type TeamMembershipRow = {
	readonly norbital_id: string;
	readonly team_id: string;
	readonly user_id: string;
};

/** Drops a membership row that lacks id, team, or user rather than rendering undefined. */
export function toTeamMembershipRow(
	record: Readonly<Record<string, unknown>>
): TeamMembershipRow[] {
	const id = text(record, 'norbital_id');
	const teamId = text(record, 'team_id');
	const userId = text(record, 'user_id');
	if (!id || !teamId || !userId) return [];
	return [{ norbital_id: id, team_id: teamId, user_id: userId }];
}
