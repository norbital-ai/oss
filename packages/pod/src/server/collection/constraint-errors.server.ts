/**
 * Turn a database constraint violation into an answer written for the person who caused it.
 *
 * `mutationRejection` deliberately refuses to show a caller anything that was not authored for
 * them: only an `HttpError` under 500 carries a `detail` sentence, and everything else collapses
 * to `INTERNAL_ERROR` so driver internals cannot leak into user copy. That rule is right, but
 * nothing translated Postgres constraint errors into that form — so two people creating a record
 * with the same unique name produced, for the loser, the literal string `INTERNAL_ERROR`. Which is
 * both useless and untrue: nothing internal failed, the write was refused for a reason the user
 * can act on.
 *
 * The column comes from the driver's `detail` (`Key (email)=(a@b.c) already exists.`) rather than
 * the constraint name, because constraint names are generated and change with the schema while the
 * detail line is a stable part of the wire protocol. The constraint name is the fallback.
 */
import { error } from './http_error.js';

/** Postgres class 23 — integrity constraint violation. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const CHECK_VIOLATION = '23514';
const EXCLUSION_VIOLATION = '23P01';

type DriverError = {
	code?: unknown;
	detail?: unknown;
	constraint?: unknown;
	column?: unknown;
	table?: unknown;
};

function asDriverError(caught: unknown): DriverError | null {
	if (!caught || typeof caught !== 'object') return null;
	const code = (caught as DriverError).code;
	return typeof code === 'string' ? (caught as DriverError) : null;
}

/** `Key (email)=(a@b.c) already exists.` → `email`; `Key (a, b)=(…)` → `a and b`. */
function columnsFromDetail(detail: unknown): string[] {
	if (typeof detail !== 'string') return [];
	const match = /^Key \(([^)]+)\)=/.exec(detail);
	if (!match?.[1]) return [];
	return match[1]
		.split(',')
		.map((column) => column.trim().replace(/^"|"$/g, ''))
		.filter(Boolean);
}

/** `employees_email_unique` → `email`, when the detail line was not available. */
function columnsFromConstraint(constraint: unknown, table: unknown): string[] {
	if (typeof constraint !== 'string') return [];
	let name = constraint;
	if (typeof table === 'string' && name.startsWith(`${table}_`))
		name = name.slice(table.length + 1);
	name = name.replace(/_(unique|key|pkey|fkey|check|idx)$/, '');
	return name ? [name] : [];
}

/** `date_of_birth` → `date of birth`. Field labels live in the manifest; this is the fallback. */
function humanize(column: string): string {
	return column.replace(/_/g, ' ').trim();
}

function listPhrase(values: readonly string[]): string {
	if (values.length <= 1) return values[0] ?? 'value';
	return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

/**
 * Rethrow a constraint violation as a caller-facing refusal, or return so the caller can rethrow
 * the original. Anything that is not a class-23 violation is left completely alone — an unexpected
 * failure must keep collapsing to `INTERNAL_ERROR` rather than be dressed up as user error.
 */
export function rethrowConstraintViolation(caught: unknown, collection: string): void {
	const driver = asDriverError(caught);
	if (!driver) return;

	const columns =
		columnsFromDetail(driver.detail).length > 0
			? columnsFromDetail(driver.detail)
			: columnsFromConstraint(driver.constraint, driver.table);
	const fields = columns.map(humanize);
	const field = columns[0];

	if (driver.code === UNIQUE_VIOLATION) {
		error(409, {
			message:
				columns.length > 0
					? `Another record already uses this ${listPhrase(fields)}.`
					: 'Another record with these details already exists.',
			code: 'UNIQUE_VIOLATION',
			collection,
			...(field ? { field } : {})
		});
	}

	if (driver.code === FOREIGN_KEY_VIOLATION) {
		error(409, {
			message:
				columns.length > 0
					? `The ${listPhrase(fields)} refers to a record that no longer exists.`
					: 'This record refers to something that no longer exists.',
			code: 'FOREIGN_KEY_VIOLATION',
			collection,
			...(field ? { field } : {})
		});
	}

	if (driver.code === NOT_NULL_VIOLATION) {
		const column = typeof driver.column === 'string' ? driver.column : undefined;
		error(400, {
			message: column ? `${humanize(column)} is required.` : 'A required value is missing.',
			code: 'NOT_NULL_VIOLATION',
			collection,
			...(column ? { field: column } : {})
		});
	}

	if (driver.code === CHECK_VIOLATION) {
		error(400, {
			message: 'That value is not allowed for this record.',
			code: 'CHECK_VIOLATION',
			collection,
			...(typeof driver.constraint === 'string' ? { constraint: driver.constraint } : {})
		});
	}

	if (driver.code === EXCLUSION_VIOLATION) {
		error(409, {
			message: 'This record overlaps another record that is already in effect.',
			code: 'EXCLUSION_VIOLATION',
			collection,
			...(typeof driver.constraint === 'string' ? { constraint: driver.constraint } : {})
		});
	}
}

/** Run a write, translating any constraint violation it raises. */
export async function withConstraintErrors<T>(
	collection: string,
	run: () => Promise<T>
): Promise<T> {
	try {
		return await run();
	} catch (caught) {
		rethrowConstraintViolation(caught, collection);
		throw caught;
	}
}
