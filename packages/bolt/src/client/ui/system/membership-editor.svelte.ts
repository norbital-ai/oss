import { getContext, setContext } from 'svelte';
import type { Effect } from 'effect';

type MembershipTeam = Readonly<{
	readonly id: string;
	readonly name: string;
}>;

/** What a team edit changes; an absent key leaves the field alone, an explicit `null` clears it. */
export type TeamChanges = Readonly<{
	readonly name?: string;
	readonly parentId?: string | null;
	readonly description?: string | null;
}>;

export type TeamDraft = Readonly<{
	readonly name: string;
	readonly parentId?: string | null;
	readonly description?: string;
}>;

export type MembershipEditor = Readonly<{
	readonly canManage: boolean;
	readonly teams: ReadonlyArray<MembershipTeam>;
	readonly assignTeam: (memberId: string, teamId: string | null) => Effect.Effect<unknown, Error>;
	readonly setMemberAdmin: (memberId: string, admin: boolean) => Effect.Effect<unknown, Error>;
	readonly invite: (email: string) => Effect.Effect<unknown, Error>;
	readonly createTeam: (draft: TeamDraft) => Effect.Effect<unknown, Error>;
	readonly updateTeam: (teamId: string, changes: TeamChanges) => Effect.Effect<unknown, Error>;
	readonly deleteTeam: (teamId: string) => Effect.Effect<unknown, Error>;
	readonly refresh: () => void;
}>;

const MEMBERSHIP_EDITOR_KEY = Symbol('bolt.membership-editor');

export const setMembershipEditor = (read: () => MembershipEditor): void => {
	setContext(MEMBERSHIP_EDITOR_KEY, read);
};

export const readMembershipEditor = (): (() => MembershipEditor | null) => {
	const read = getContext<(() => MembershipEditor) | undefined>(MEMBERSHIP_EDITOR_KEY);
	return () => (read === undefined ? null : read());
};
