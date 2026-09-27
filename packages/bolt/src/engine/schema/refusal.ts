// SQLSTATE → refusal (§5.2), through the manifest by constraint name. Any SQLSTATE outside the table is a bug and
// comes back as a `BoltError` carrying the `DbError` (rule 72a); `conflict` is the write's to replay (rule 26).
import type { Refused } from '../../decl/ctx.ts';
import { BoltError, type DbError } from '../contracts.ts';
import type { ConstraintMeta } from './ddl.ts';

const quoted = (message: string, before: string): string | undefined => new RegExp(`${before} "([^"]+)"`).exec(message)?.[1];

export function refusalOf(e: DbError, constraints: ReadonlyMap<string, ConstraintMeta>): Refused | 'conflict' | BoltError {
	const meta = e.constraint === undefined ? undefined : constraints.get(e.constraint);
	const field = meta?.fields.length === 1 ? { field: meta.fields[0] as string } : {};
	const names = meta === undefined ? '' : `${meta.model}: ${meta.rule ?? meta.fields.join(', ')}`;
	const refused = (code: Refused['code'], message: string, extra: { field?: string } = field): Refused => ({ kind: 'refused', code, message, ...extra });
	switch (e.sqlstate) {
		case '23505': return refused('unique', `another record already has this ${names || 'value'}`);
		case '23503': return /^update or delete on table/.test(e.message)
			? refused('restricted', `other records still refer to this one (${names || e.constraint})`, {})
			: refused('missingRef', `the referenced record does not exist (${names || e.constraint})`);
		case '23514': return refused('check', meta?.message ?? `the record breaks ${meta?.rule === undefined ? `the rules of ${names || e.constraint}` : `the rule '${meta.rule}'`}`);
		// a partial `unique` is an EXCLUDE, so it reports 23P01 under its declared kind
		case '23P01': return meta?.kind === 'unique'
			? refused('unique', `another record already has this ${names}`)
			: refused('overlap', `the period overlaps another record's (${names || e.constraint})`);
		case '23502': {
			const column = quoted(e.message, 'column');
			return refused('required', `${column ?? 'a field'} is required`, column === undefined ? {} : { field: column });
		}
		case '22003': return refused('overflow', 'a number is out of range', {});
		case '40001': case '40P01': return 'conflict';
		case '57014': return new BoltError('timeout', 'facility', 'the database did not answer within its wall', e);
		default: return new BoltError('bug', 'commit', `unexpected database error ${e.sqlstate}: ${e.message}`, e);
	}
}
