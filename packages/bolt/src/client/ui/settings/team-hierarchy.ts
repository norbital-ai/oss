/**
 * Deterministic layout for the workspace team chart.
 *
 * Pure by design: given the same teams it returns the same coordinates, so the chart can be asserted
 * without rendering it. A parent sits over the midpoint of its own subtree, and leaves claim columns
 * left to right, which is what keeps sibling branches from overlapping as the tree deepens.
 */

export type TeamNode = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly parentId?: string | null;
}>;

export type HierarchyPosition = Readonly<{
	readonly id: string;
	readonly x: number;
	readonly y: number;
}>;

export type HierarchyEdge = Readonly<{
	readonly parentId: string;
	readonly childId: string;
}>;

export type TeamHierarchy = Readonly<{
	readonly positions: ReadonlyArray<HierarchyPosition>;
	readonly edges: ReadonlyArray<HierarchyEdge>;
	readonly width: number;
	readonly height: number;
}>;

const byName = (left: TeamNode, right: TeamNode): number =>
	left.name.localeCompare(right.name) || left.id.localeCompare(right.id);

export const layoutTeamHierarchy = (
	teams: ReadonlyArray<TeamNode>,
	horizontalPitch = 300,
	verticalPitch = 130
): TeamHierarchy => {
	const known = new Set(teams.map((team) => team.id));
	const children = new Map<string, Array<TeamNode>>();
	const roots: Array<TeamNode> = [];
	for (const team of teams) {
		const parentId = team.parentId ?? null;
		// A team whose parent was deleted, or points outside this set, is a root rather than an
		// orphan the layout drops — the chart still has to show it.
		if (parentId === null || parentId === team.id || !known.has(parentId)) {
			roots.push(team);
			continue;
		}
		children.set(parentId, [...(children.get(parentId) ?? []), team]);
	}
	roots.sort(byName);
	for (const siblings of children.values()) siblings.sort(byName);

	let leafColumn = 0;
	const positions = new Map<string, HierarchyPosition>();
	const visited = new Set<string>();
	const visit = (team: TeamNode, depth: number): number => {
		// A cycle would otherwise recurse forever; treating a revisit as a leaf keeps the chart finite.
		if (visited.has(team.id)) return positions.get(team.id)?.x ?? 0;
		visited.add(team.id);
		const descendants = children.get(team.id) ?? [];
		const placed = descendants.map((child) => visit(child, depth + 1));
		const first = placed[0];
		const last = placed[placed.length - 1];
		const x = first === undefined || last === undefined ? leafColumn++ * horizontalPitch : (first + last) / 2;
		positions.set(team.id, { id: team.id, x, y: depth * verticalPitch });
		return x;
	};
	for (const root of roots) visit(root, 0);
	// A cycle has no root, so nothing above would have reached it and those teams would simply be
	// absent from the chart. Anything still unplaced is drawn as its own root instead of vanishing.
	for (const team of [...teams].sort(byName)) {
		if (!visited.has(team.id)) visit(team, 0);
	}

	const ordered = teams.flatMap((team) => {
		const position = positions.get(team.id);
		return position === undefined ? [] : [position];
	});
	const edges = teams.flatMap((team) => {
		const parentId = team.parentId ?? null;
		return parentId !== null && parentId !== team.id && known.has(parentId) && positions.has(team.id)
			? [{ parentId, childId: team.id }]
			: [];
	});
	return {
		positions: ordered,
		edges,
		width: ordered.reduce((widest, position) => Math.max(widest, position.x), 0),
		height: ordered.reduce((tallest, position) => Math.max(tallest, position.y), 0)
	};
};
