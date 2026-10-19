// Source access catalogue: handles identify teams; labels and hierarchy never confer another team's policies.
import type { Checked } from '../fields.ts';
import type { PolicyName } from '../names.ts';

/** A source team with optional display label and parent, holding only its explicitly listed policies. */
export type TeamSpec = {
	readonly name?: string;
	readonly parent?: string | null;
	readonly policies: readonly PolicyName[];
};
/** A source team entry: a policy list, or a structured team definition. */
export type TeamEntry = readonly PolicyName[] | TeamSpec;
export type TeamData = {
	readonly name?: string;
	readonly parent?: string | null;
	readonly policies: readonly string[];
};
export type TeamEntries = { readonly [handle: string]: readonly string[] | TeamData };
export type SourceTeam = {
	readonly name: string;
	readonly parent: string | null;
	readonly policies: readonly string[];
};
type TeamBase = TeamEntries;
type TeamsFor<T> = {
	[K in keyof T]: T[K] extends readonly string[]
		? readonly PolicyName[]
		: {
				readonly name?: string;
				readonly parent?: (Exclude<keyof T, K> & string) | null;
				readonly policies: readonly PolicyName[];
			};
};

/** `src/access_control/team/+team.ts`: stable team handles, optional display labels/parents and source policies. */
export function team<const T extends TeamBase>(spec: T & Checked<TeamBase, T, TeamsFor<T>>): T {
	return spec;
}
