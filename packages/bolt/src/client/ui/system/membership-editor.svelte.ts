import { getContext, setContext } from 'svelte';
import type { Effect } from 'effect';

type MembershipTeam = Readonly<{
	readonly id: string;
	readonly name: string;
}>;

type MembershipEditor = Readonly<{
	readonly canManage: boolean;
	readonly teams: ReadonlyArray<MembershipTeam>;
	readonly assignTeam: (
		memberId: string,
		teamId: string | null
	) => Effect.Effect<unknown, Error>;
	readonly setMemberAdmin: (memberId: string, admin: boolean) => Effect.Effect<unknown, Error>;
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
