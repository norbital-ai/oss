// Source access catalogue: handles identify teams; labels and hierarchy never confer another team's policies.
// A handle is readable snake_case words (`hr_manager`, `field_ops_controllers`): members, invitations and API keys carry
// it, approval flows name it, and seeded `sys_user` rows name it in `team`.
import type { Checked } from '../fields.ts';
import type { PolicyName } from '../names.ts';

/** A source team with optional display label and parent (which scopes data, never passes policies down), holding only its listed policies. */
export type TeamSpec = {
	readonly name?: string;
	readonly parent?: string | null;
	readonly policies: readonly PolicyName[];
};
/** A source team entry: a policy list, or a structured team definition. */
export type TeamEntry = readonly PolicyName[] | TeamSpec;
/** A team entry as the manifest holds it. */
export type TeamData = {
	readonly name?: string;
	readonly parent?: string | null;
	readonly policies: readonly string[];
};
/** Every team entry by handle, as the manifest holds them. */
export type TeamEntries = { readonly [handle: string]: readonly string[] | TeamData };
/** A team resolved from its entry: label (the handle when none), parent and policies. */
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

/**
 * `src/access_control/team/+team.ts`: stable team handles (snake_case words) mapped to their policies, or to an optional
 * display label, parent and policies.
 * @example
 * export default team({
 * 	hr_manager: { name: 'HR Manager', policies: ['hr_admin'] },
 * 	field_ops_controllers: ['field_ops_controller']
 * });
 */
export function team<const T extends TeamBase>(spec: T & Checked<TeamBase, T, TeamsFor<T>>): T {
	return spec;
}
