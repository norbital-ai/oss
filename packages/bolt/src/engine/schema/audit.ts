import { q, literal as lit } from '@norbital-ai/std/sql';
import type { SchemaObject, TableSpec } from '@norbital-ai/store';



export { AUDIT_FUNCTIONS } from './audit-sql.ts';

/** Raw SQL history for audited workspace tables: an act's own statement writes its rows' history, so its rows skip it. */
export const audit_triggers = (
	tables: Readonly<Record<string, TableSpec>>
): readonly SchemaObject[] =>
	Object.entries(tables).flatMap(([name, table]): SchemaObject[] => {
		if (table.audit !== true) return [];
		const refs = Object.entries(table.fields)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.flatMap(([field, spec]) => {
				if (spec.kind !== 'ref') return [];
				const targets = typeof spec.to === 'string' ? [spec.to] : spec.to;
				return targets.map((target) => ({
					edge: [targets.length > 1 ? `${field}__${target}` : field, target],
					owned: spec.owned === true
				}));
			});
		const args = [
			refs.filter((ref) => ref.owned).map((ref) => ref.edge),
			refs.map((ref) => ref.edge)
		]
			.map((edges) => lit(JSON.stringify(edges)))
			.join(',');
		return [
			{
				id: `engine:audit:${name}`,
				rank: 'index',
				table: '',
				deps: [],
				drop: null,
				create: [
					`drop trigger if exists bolt_audit_mark on ${q(name)}`,
					`drop trigger if exists bolt_audit on ${q(name)}`,
					`create trigger bolt_audit after insert or update or delete on ${q(name)} for each row when (current_setting('bolt.write', true) is distinct from statement_timestamp()::text) execute function bolt_audit(${args})`
				]
			}
		];
	});
