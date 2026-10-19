import { Cause, Option, Predicate, Result } from 'effect';
import type { BodyError } from '../ctx.ts';
import { ActConflict, ActRefused, ActUnknown } from '../errors/act.ts';
import { Refusal } from '../errors/refusal.ts';

/** A refusal as the prelude's `failure` reads it. */
const refused = (message: string, field?: string) => ({ kind: 'refused', message, field });
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
 * that conflicted or is unknown is refused with its outcome's JSON, as an async body's uncaught one is; any other failure
 * is an `Error` named by its tag (a tagged error is one; its `kind` rides the prelude tuple); a defect is itself; an
 * interruption is `Error('interrupted')`. Canonical class identity, rather than tags, selects the refusal cases.
 */
export const finalOf = (cause: Cause.Cause<BodyError>): unknown => {
	const failure = Cause.findErrorOption(cause);
	if (Option.isSome(failure)) {
		const e = failure.value;
		return e instanceof Refusal || e instanceof ActRefused
			? refused(e.message, e.field)
			: e instanceof ActConflict
				? refused(JSON.stringify({ kind: 'conflict', records: e.records }))
				: e instanceof ActUnknown
					? refused(JSON.stringify({ kind: 'unknown', invocation: e.invocation }))
					: e instanceof Error
						? e
						: named(e);
	}
	const defect = Cause.findDefect(cause);
	return Result.isSuccess(defect) ? defect.success : new Error('interrupted');
};
