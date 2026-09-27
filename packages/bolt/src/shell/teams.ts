// The team chart's geometry (staging's `team-hierarchy.ts`): pure, so the chart is asserted without rendering it. A
// parent sits over the midpoint of its own subtree and leaves claim columns left to right, so sibling branches never
// overlap. A team whose parent is gone, itself, or a cycle is drawn as a root rather than dropped.

export type TeamNode = { id: string; name: string; parent: string | null };
export type TeamChart = { positions: { id: string; x: number; y: number }[]; edges: { parent: string; child: string }[] };

const byName = (a: TeamNode, b: TeamNode) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const parentIn = (t: TeamNode, known: ReadonlySet<string>) => t.parent !== null && t.parent !== t.id && known.has(t.parent) ? t.parent : null;

export function layoutTeams(teams: readonly TeamNode[], dx = 280, dy = 140): TeamChart {
	const known = new Set(teams.map((t) => t.id));
	const children = new Map<string, TeamNode[]>();
	for (const t of teams) {
		const p = parentIn(t, known);
		if (p !== null) children.set(p, [...(children.get(p) ?? []), t]);
	}
	const at = new Map<string, { id: string; x: number; y: number }>();
	let column = 0;
	const visit = (t: TeamNode, depth: number): number => {
		const seen = at.get(t.id);
		if (seen !== undefined) return seen.x;
		at.set(t.id, { id: t.id, x: 0, y: depth * dy }); // placed before its children, so a cycle ends here
		const xs = (children.get(t.id) ?? []).sort(byName).map((c) => visit(c, depth + 1));
		const x = xs.length === 0 ? column++ * dx : (xs[0]! + xs.at(-1)!) / 2;
		at.set(t.id, { id: t.id, x, y: depth * dy });
		return x;
	};
	for (const t of [...teams].sort(byName)) if (parentIn(t, known) === null) visit(t, 0);
	for (const t of [...teams].sort(byName)) visit(t, 0); // a cycle has no root: its teams still show
	return { positions: teams.map((t) => at.get(t.id)!),
		edges: teams.flatMap((t) => { const p = parentIn(t, known); return p === null ? [] : [{ parent: p, child: t.id }]; }) };
}

/** The teams a search keeps: every match and the teams above it, so the path to a match stays visible. */
export function searchTeams(teams: readonly TeamNode[], query: string): TeamNode[] {
	const q = query.trim().toLocaleLowerCase();
	if (q === '') return [...teams];
	const byId = new Map(teams.map((t) => [t.id, t]));
	const kept = new Set<string>();
	for (const t of teams) {
		if (!t.name.toLocaleLowerCase().includes(q)) continue;
		for (let x: TeamNode | undefined = t; x !== undefined && !kept.has(x.id); x = x.parent === null ? undefined : byId.get(x.parent)) kept.add(x.id);
	}
	return teams.filter((t) => kept.has(t.id));
}

/** `id` and every team under it: a team cannot move into its own subtree. */
export function subtree(teams: readonly TeamNode[], id: string): Set<string> {
	const out = new Set<string>([id]);
	for (let grew = true; grew;) {
		grew = false;
		for (const t of teams) if (t.parent !== null && out.has(t.parent) && !out.has(t.id)) { out.add(t.id); grew = true; }
	}
	return out;
}
