// SQLSTATE → refusal, through the manifest by constraint name. Any SQLSTATE outside the table is a bug and
// comes back as a `BoltError` carrying the `DbError`; `conflict` is the write's to replay.
import type { Refused } from '../contracts.ts';
import type { DbError } from '@norbital-ai/host-api';
import { BoltError } from '../../protocol/errors.ts';
import type { ConstraintMeta } from '@norbital-ai/store';

const quoted = (message: string, before: string): string | undefined =>
	new RegExp(`${before} "([^"]+)"`).exec(message)?.[1];

/** A constraint as the SQLSTATE map reads it: its authored message's catalogue `key` beside the rendered `message`. */
export type RuleMeta = ConstraintMeta & { readonly key?: string };

export function refusalOf(
	e: DbError,
	constraints: ReadonlyMap<string, RuleMeta>
): Refused | 'conflict' | BoltError {
	const meta = e.constraint === undefined ? undefined : constraints.get(e.constraint);
	const column = (meta?.fields.length === 1 ? meta.fields[0] : undefined) ?? e.column;
	const field = column === undefined ? {} : { field: column };
	const names = meta === undefined ? '' : `${meta.model}: ${meta.rule ?? meta.fields.join(', ')}`;
	const refused = (
		code: Refused['code'],
		message: string,
		extra: { field?: string } = field
	): Refused =>
		// an authored rule message replaces the default text, keyed as an authored refusal is
		meta?.key !== undefined && meta.message !== undefined
			? { kind: 'refused', code, message: meta.message, key: meta.key, ...extra }
			: { kind: 'refused', code, message, ...extra };
	switch (e.sqlstate) {
		case '23505':
			return refused('unique', `another record already has this ${names || 'value'}`);
		case '23001':
			return refused(
				'restricted',
				`other records still refer to this one (${names || e.constraint})`,
				{}
			);
		case '23503':
			return /^update or delete on table/.test(e.message)
				? refused(
						'restricted',
						`other records still refer to this one (${names || e.constraint})`,
						{}
					)
				: refused('missing_ref', `the referenced record does not exist (${names || e.constraint})`);
		case '23514': {
			if (meta?.kind === 'locked') return refused('locked', 'This record is locked and cannot be changed.');
			// the native row rules (store `rules.ts`) name no constraint: a state move, a new row's initial state, a key
			if (meta === undefined && e.constraint === undefined) return refused('invalid_input', e.message);
			const rule = names || e.constraint;
			return refused(
				'check',
				meta?.message ??
					(meta?.rule === undefined
						? rule === undefined
							? 'a native rule refused the record'
							: meta?.fields.length === 1
								? // a field's own kind check: its value is not that kind (a list, an enum value, a format)
									`${meta.model}.${meta.fields[0]} is not a valid value for its kind: describe the model for its shape (a file field takes the reference a message lists, whole, and a multiple one a list of them)`
								: `the record breaks the rules of ${rule}`
						: `the record breaks the rule '${meta.rule}'`)
			);
		}
		// a partial `unique` is an EXCLUDE, so it reports 23P01 under its declared kind
		case '23P01':
			return meta?.kind === 'unique'
				? refused('unique', `another record already has this ${names}`)
				: refused('overlap', `the period overlaps another record's (${names || e.constraint})`);
		case '23502': {
			const column = e.column ?? quoted(e.message, 'column');
			return refused(
				'required',
				`${column ?? 'a field'} is required`,
				column === undefined ? {} : { field: column }
			);
		}
		case '22003':
			return refused('overflow', 'a number is out of range', {});
		case '40001':
		case '40P01':
		// `lock_timeout` (wire.ts): a concurrent act held a lock this statement needs; replayed once, then `conflict`
		case '55P03':
			return 'conflict';
		case '57014':
			return BoltError.make(
				'timeout',
				'facility',
				'the database did not answer within its wall',
				e
			);
		default:
			return BoltError.make(
				'bug',
				'commit',
				`unexpected database error ${e.sqlstate}: ${e.message}`,
				e
			);
	}
}
