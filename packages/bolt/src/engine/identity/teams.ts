import { literal, q } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import type { EngineActor } from '../contracts.ts';

/** A member's primary team, plus a staff member's current supplementary teams. The `u` alias is sys_user. */
export function memberTeams(workspace: Pick<EngineManifest['workspace'], 'memberships' | 'tz'>, now: string): string {
	const primary = 'array_remove(ARRAY[u.team]::text[], NULL)';
	const spec = workspace.memberships;
	if (spec === undefined) return primary;
	const today = `(${now}::timestamptz AT TIME ZONE ${literal(workspace.tz)})::date`;
	const active = (alias: string) => `${alias}.member = u.id AND (${alias}.until IS NULL OR ${alias}.until >= ${today})`;
	const direct = `SELECT g.team FROM ${q(spec.model)} g WHERE ${active('g')}`;
	const grants = spec.bundles === undefined ? direct : `${direct} UNION ALL
		SELECT level.team FROM ${q(spec.bundles.assignments)} a JOIN ${q(spec.bundles.levels)} level ON level.role = a.role
		WHERE ${active('a')}`;
	// Stable order is part of the authority cache key.
	return `(${primary} || ARRAY(SELECT DISTINCT g.team FROM (${grants}) g
		WHERE u.kind = 'staff' AND g.team <> ALL(${primary}) ORDER BY g.team))`;
}

export function membershipModels(workspace: EngineManifest['workspace']): string[] {
	const spec = workspace.memberships;
	return spec === undefined ? [] : [spec.model, ...(spec.bundles === undefined ? [] : [spec.bundles.assignments, spec.bundles.levels])];
}

/** Only a native administrator or a declared automation can write the tables that convey identity. */
export const membershipWriter = (actor: EngineActor, admin: boolean) =>
	admin || (actor.kind === 'system' && 'automation' in actor.by);
