import type { TeamRow } from '../shell/workspace-settings.js';

export interface HierarchyPosition {
	readonly id: string;
	readonly x: number;
	readonly y: number;
}

/** Deterministic tree layout: parents sit over the midpoint of their leaf descendants. */
export function layoutTeamHierarchy(
	teams: readonly TeamRow[],
	horizontalPitch = 300,
	verticalPitch = 130
): HierarchyPosition[] {
	const teamIds = new Set(teams.map((team) => team.norbital_id));
	const children = new Map<string, TeamRow[]>();
	const roots: TeamRow[] = [];
	for (const team of teams) {
		if (!team.parent_id || !teamIds.has(team.parent_id)) {
			roots.push(team);
			continue;
		}
		children.set(team.parent_id, [...(children.get(team.parent_id) ?? []), team]);
	}
	const byName = (left: TeamRow, right: TeamRow) =>
		left.name.localeCompare(right.name) || left.norbital_id.localeCompare(right.norbital_id);
	roots.sort(byName);
	for (const siblings of children.values()) siblings.sort(byName);

	let leafColumn = 0;
	const positions = new Map<string, HierarchyPosition>();
	function visit(team: TeamRow, depth: number): number {
		const descendants = children.get(team.norbital_id) ?? [];
		const x =
			descendants.length === 0
				? leafColumn++ * horizontalPitch
				: (() => {
						const childXs = descendants.map((child) => visit(child, depth + 1));
						return (childXs[0] + childXs.at(-1)!) / 2;
					})();
		positions.set(team.norbital_id, { id: team.norbital_id, x, y: depth * verticalPitch });
		return x;
	}
	for (const root of roots) visit(root, 0);
	return teams.flatMap((team) => {
		const position = positions.get(team.norbital_id);
		return position ? [position] : [];
	});
}
