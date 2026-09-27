// `team()` (§3.3.1, §3.8): `src/access/+team.ts`, the team names (matched to team rows, case-insensitive) and the
// policies each holds. Its keys are `TeamName`, so an approval step naming an unknown team is a tsc error.
import type { Checked } from '../fields.ts';
import type { PolicyName } from '../names.ts';

type TeamBase = { readonly [team: string]: readonly string[] };

// team rows match case-insensitively, so two keys equal but for case would name one team twice
type TeamsFor<T> = { [K in keyof T]: Lowercase<K & string> extends Lowercase<Exclude<keyof T, K> & string>
	? `error: team '${K & string}' differs from another only in case` : readonly PolicyName[] };
/**
 * `src/access/+team.ts`: the team names (matched to team rows case-insensitively) and the policies each team's members
 * hold. Returns the literal; its keys become `TeamName`.
 * @example
 * export default team({ 'HR Manager': ['hr_manager'], Staff: ['employee'] });
 */
export function team<const T extends TeamBase>(spec: T & Checked<TeamBase, T, TeamsFor<T>>): T {
	return spec;
}
