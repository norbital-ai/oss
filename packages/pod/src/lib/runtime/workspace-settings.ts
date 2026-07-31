/**
 * What the settings surface renders, and the contract it renders it through.
 *
 * Deliberately free of imports that reach the transport: the concrete client lives in
 * `workspace-settings-api.ts`, because `runtime/client.ts` pulls in the whole sync engine (and with it
 * PGlite) and this module is what a component test mounts the surface against.
 */
import type { TUserRole } from '@norbital-ai/platform-utils/system/types';

export type WorkspaceInvitation = {
	readonly norbital_id: string;
	readonly email: string;
	readonly role: string;
	readonly status: 'pending' | 'accepted' | 'expired';
	readonly created_at: string;
	readonly expires_at: string;
};

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
	}): Promise<{ invitationId: string; acceptUrl: string; email: string }>;
	revokeInvitation(invitationId: string): Promise<{ revoked: boolean }>;
	setMemberRole(userId: string, role: TUserRole): Promise<unknown>;
	createTeam(name: string): Promise<unknown>;
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
export type MemberRow = {
	readonly norbital_id: string;
	readonly email: string;
	readonly name: string;
	readonly role: string;
	readonly status: string;
};

export type TeamRow = {
	readonly norbital_id: string;
	readonly name: string;
	readonly policy_id: string | null;
};

export type PolicyRow = {
	readonly norbital_id: string;
	readonly name: string;
	readonly is_active: boolean;
};

function text(record: Readonly<Record<string, unknown>>, field: string): string | null {
	const value = record[field];
	return typeof value === 'string' ? value : null;
}

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

export function toTeamRow(record: Readonly<Record<string, unknown>>): TeamRow[] {
	const id = text(record, 'norbital_id');
	const name = text(record, 'name');
	if (!id || !name) return [];
	return [{ norbital_id: id, name, policy_id: text(record, 'policy_id') }];
}

export function toPolicyRow(record: Readonly<Record<string, unknown>>): PolicyRow[] {
	const id = text(record, 'norbital_id');
	const name = text(record, 'name');
	if (!id || !name) return [];
	return [{ norbital_id: id, name, is_active: record.is_active !== false }];
}

export type TeamMembershipRow = {
	readonly norbital_id: string;
	readonly team_id: string;
	readonly user_id: string;
};

export function toTeamMembershipRow(
	record: Readonly<Record<string, unknown>>
): TeamMembershipRow[] {
	const id = text(record, 'norbital_id');
	const teamId = text(record, 'team_id');
	const userId = text(record, 'user_id');
	if (!id || !teamId || !userId) return [];
	return [{ norbital_id: id, team_id: teamId, user_id: userId }];
}
