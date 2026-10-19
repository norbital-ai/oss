import { Equal } from 'effect';
import { encodeWire } from '@norbital-ai/std/wire';
import type { Row, Values } from '../collection/types.js';
export type RowsOps = {
	create?: Values[];
	update?: { target: string; set: Values }[];
	delete?: string[];
};
export function rowsOps(
	loaded: readonly Row[],
	current: readonly Values[],
	removed: readonly string[]
): RowsOps {
	const byId = new Map(loaded.map((r) => [r.id, r]));
	const create: Values[] = [],
		update: { target: string; set: Values }[] = [];
	for (const r of current) {
		const was = typeof r['id'] === 'string' ? byId.get(r['id']) : undefined;
		if (was === undefined) {
			const { id: _, ...values } = r;
			create.push(values);
			continue;
		}
		const set = Object.fromEntries(
			Object.entries(r).filter(
				([k, v]) => k !== 'id' && !Equal.equals(encodeWire(v), encodeWire(was[k] ?? null))
			)
		);
		if (Object.keys(set).length > 0) update.push({ target: was.id, set });
	}
	const del = removed.filter((id) => byId.has(id));
	return {
		...(create.length ? { create } : {}),
		...(update.length ? { update } : {}),
		...(del.length ? { delete: del } : {})
	};
}
