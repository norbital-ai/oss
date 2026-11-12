import type { AgentRow } from '../../protocol/wire.ts';

export function context_meter(rows: readonly AgentRow[]) {
	const usages = rows.flatMap((row) => row.usage === undefined ? [] : [row.usage]);
	const last = usages.findLast((u) => u.context !== undefined && u.window !== undefined);
	const costs = usages.filter((u) => typeof u.cost === 'number');
	return {
		percent:
			last?.context === undefined || last.window === undefined || last.window === 0
				? null
				: Math.min(100, (last.context / last.window) * 100),
		context: last?.context,
		window: last?.window,
		input: usages.reduce((n, u) => n + u.input, 0),
		cached: usages.reduce((n, u) => n + (u.cached ?? 0), 0),
		output: usages.reduce((n, u) => n + u.output, 0),
		reasoning: usages.reduce((n, u) => n + (u.reasoning ?? 0), 0),
		cost: costs.length === 0 ? null : costs.reduce((n, u) => n + (u.cost ?? 0), 0)
	};
}
export const token_count = (n: number | undefined) =>
	n === undefined ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
