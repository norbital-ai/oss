import { Cause, Option, Predicate, Result } from 'effect';
import type { BodyError } from '../ctx.ts';
import { ActConflict, ActRefused, ActUnknown } from '../errors/act.ts';
import { Refusal } from '../errors/refusal.ts';

/** A refusal as the prelude's `failure` reads it (`row`: a write callback's batch index). */
const refused = (message: string, field?: string, row?: number) => ({
	kind: 'refused',
	code: 'refused',
	message,
	field,
	row
});
/** A failure that is no `Error`: an `Error` named by its tag. */
const named = (failure: unknown): Error => {
	const error = new Error(
		Predicate.hasProperty(failure, 'message') && Predicate.isString(failure.message)
			? failure.message
			: String(failure)
	);
	error.name =
		Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag)
			? failure._tag
			: 'Error';
	return error;
};

/**
 * What a failed body settles as (B.3): a refusal or a refused write is `refused` with its message and field; a write
 * that conflicted or is unknown retains its native family and metadata in the failed run; any other failure
 * is an `Error` named by its tag (a tagged error is one; its `kind` rides the prelude tuple); a defect is itself; an
 * interruption is `Error('interrupted')`. Canonical class identity, rather than tags, selects the refusal cases.
 */
export const finalOf = (cause: Cause.Cause<BodyError>): unknown => {
	const failure = Cause.findErrorOption(cause);
	if (Option.isSome(failure)) {
		const e = failure.value;
		return e instanceof Refusal
			? refused(e.message, e.field, e.row)
			: e instanceof ActRefused
				? {
						...refused(e.message, e.field, e.row),
						code: e.code,
						rows: e.rows,
						rule: e.rule,
						data: e.data
					}
				: e instanceof ActConflict
					? { ...refused(e.message), code: 'conflict', records: e.records }
					: e instanceof ActUnknown
						? { ...refused(e.message), code: 'unknown', invocation: e.invocation }
						: e instanceof Error
							? e
							: named(e);
	}
	const defect = Cause.findDefect(cause);
	return Result.isSuccess(defect) ? defect.success : new Error('interrupted');
};
