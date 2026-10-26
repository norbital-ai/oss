import { Schema } from 'effect';
import type { SchemaObject, TableSpec } from '@norbital-ai/store';

/** Native operation metadata, transported on the leased connection; the SQL owner remains trusted. */
export const WriteContext = Schema.Struct({
	token: Schema.String,
	now: Schema.String,
	actor: Schema.String,
	direct: Schema.Array(Schema.String),
	erased: Schema.Array(Schema.String),
	mode: Schema.Literals(['write', 'seed', 'restore']),
	cause: Schema.optionalKey(Schema.Literals(['direct', 'derived', 'seed'])),
	request: Schema.optionalKey(Schema.String),
	restored: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number))
});
export type WriteContext = typeof WriteContext.Type;

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

export { AUDIT_FUNCTIONS } from './audit-sql.ts';

/** Only audited workspace tables use this history path; table-shaped system models retain their own writers. */
export const auditTriggers = (
	tables: Readonly<Record<string, TableSpec>>
): readonly SchemaObject[] =>
	Object.entries(tables).flatMap(([name, table]): SchemaObject[] => {
		if (table.audit !== true || table.nativeRules === undefined) return [];
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
					`create trigger bolt_audit_mark before insert or update or delete on ${q(name)} for each row execute function bolt_audit_mark(${args})`,
					`drop trigger if exists bolt_audit on ${q(name)}`,
					`create trigger bolt_audit after insert or update or delete on ${q(name)} for each row execute function bolt_audit(${args})`
				]
			}
		];
	});
