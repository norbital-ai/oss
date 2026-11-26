// `sys_team` rows for a fixture: a test names its teams by id, as a seeded workspace's rows do.
type Teams = {
	readonly [id: string]: {
		readonly name?: string;
		readonly parent?: string;
		readonly policies: readonly string[];
	};
};
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The teams as seed rows (`TestWorkspace.layer({ seed: { sys_team } })`). */
export const team_rows = (teams: Teams) =>
	Object.entries(teams).map(([id, team]) => ({
		id,
		name: team.name ?? id,
		parent: team.parent ?? null,
		policies: [...team.policies]
	}));

/** One `INSERT` of every team, so a parent and its children land together; a team already as given is left alone. */
export const teams_sql = (teams: Teams): string =>
	`INSERT INTO sys_team (id, name, parent, policies) VALUES ${team_rows(teams)
		.map(
			(team) =>
				`(${text(team.id)}, ${text(team.name)}, ${team.parent === null ? 'NULL' : text(team.parent)}, ARRAY[${team.policies.map(text).join(', ')}]::text[])`
		)
		.join(', ')} ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent = EXCLUDED.parent, policies = EXCLUDED.policies, revision = sys_team.revision + 1
		WHERE (sys_team.name, sys_team.parent, sys_team.policies) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.parent, EXCLUDED.policies)`;
