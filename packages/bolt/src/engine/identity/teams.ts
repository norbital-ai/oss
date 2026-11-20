import { literal, q } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import type { EngineActor } from '../contracts.ts';

/** A member's primary team, plus a staff member's current supplementary teams. The `u` alias is sys_user. */
export function memberTeams(workspace: Pick<EngineManifest['workspace'], 'memberships' | 'tz'>, now: string): string {
	const primary = 'array_remove(ARRAY[u.team]::text[], NULL)';
	const spec = workspace.memberships;
	if (spec === undefined) return primary;
	const baseline = spec.staff_team === undefined ? primary :
		`(${primary} || ARRAY(SELECT ${literal(spec.staff_team)}::text WHERE u.kind = 'staff' AND u.team IS DISTINCT FROM ${literal(spec.staff_team)}))`;
	const available = spec.teams.map(team => {
		const group = spec.groups?.findIndex(levels => levels.includes(team)) ?? -1;
		return {
			team,
			bucket: group < 0 ? team : ':' + group,
			rank: spec.groups?.[group]?.indexOf(team) ?? 0,
			separate: spec.keep_direct?.includes(team) ?? false
		};
	});
	const today = `(${now}::timestamptz AT TIME ZONE ${literal(workspace.tz)})::date`;
	const active = (alias: string) => `${alias}.member = u.id AND (${alias}.until IS NULL OR ${alias}.until >= ${today})`;
	const direct = `SELECT g.team, true AS direct FROM ${q(spec.model)} g WHERE ${active('g')}`;
	const grants = spec.bundles === undefined ? direct : `${direct} UNION ALL
		SELECT level.team, false AS direct FROM ${q(spec.bundles.assignments)} a JOIN ${q(spec.bundles.levels)} level ON level.role = a.role
		WHERE ${active('a')}`;
	// Pick the highest live grant in each source group. Stable order is part of the authority cache key.
	return `(${baseline} || ARRAY(SELECT DISTINCT effective.team FROM (
		SELECT DISTINCT ON (roles.bucket, g.direct AND roles.separate) g.team FROM (${grants}) g
		JOIN jsonb_to_recordset(${literal(JSON.stringify(available))}::jsonb) AS roles(team text, bucket text, rank int, separate boolean)
		ON roles.team = g.team WHERE u.kind = 'staff' ORDER BY roles.bucket, g.direct AND roles.separate, roles.rank DESC
	) effective WHERE effective.team <> ALL(${baseline}) ORDER BY effective.team))`;
}

export function membershipModels(workspace: EngineManifest['workspace']): string[] {
	const spec = workspace.memberships;
	return spec === undefined ? [] : [spec.model, ...(spec.bundles === undefined ? [] : [spec.bundles.assignments, spec.bundles.levels])];
}

/** Only a native administrator or a declared automation can write the tables that convey identity. */
export const membershipWriter = (actor: EngineActor, admin: boolean) =>
	admin || (actor.kind === 'system' && 'automation' in actor.by);
