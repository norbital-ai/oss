import { Schema } from 'effect';

/**
 * The tag an authored refusal is recognised by, as a string constant.
 *
 * Recognition is structural rather than `instanceof` because the throw and the catch do not
 * reliably share a class. `refuse` is thrown from `@norbital-ai/bolt/authoring`, inside the
 * compiled tenant artifact; it is caught in `@norbital-ai/bolt/runtime`, which the same artifact
 * also imports. Those are two entry points of one package and a bundler that gives them separate
 * module instances — a different `exports` condition resolved for each, a duplicated copy under a
 * transitive dependency — would produce two `AuthoredRefusal` classes that are identical in every
 * way except the one that `instanceof` reads. The failure that buys is silent and total: every
 * refusal falls through to the defect branch and reports as a 500 again, which is the whole thing
 * this change exists to stop. A tag comparison cannot fail that way.
 */
export const AUTHORED_REFUSAL_TAG = 'Bolt.Authored.Refusal';

/**
 * A business rule said no.
 *
 * This is the typed carrier for `refuse`, and it is deliberately not an infrastructure error.
 * "A payslip cannot be deleted without its payroll run" is the workspace working correctly: the
 * request was well formed, the caller was entitled to make it, and the answer is no. Reported as a
 * defect it becomes indistinguishable from a runtime that fell over, which is what the host used to
 * see — `refuse` threw, `Effect.orDie` made it a defect, the defect bypassed every mapping in
 * `runtime/app.ts` and arrived at the host as an `ExecutionFailure`. A consumer could not tell
 * "you may not" from "we broke", and the sentence the author wrote — the only part anyone can act
 * on — reached the surface wrapped in a `_tag` no person should be reading.
 *
 * `collection` and `action` are optional because the call site does not know them. `refuse` is a
 * bare authoring helper with one argument; the *seam* that catches the throw knows which collection
 * and which phase it was running, and stamps them on the way past. A refusal raised somewhere with
 * no collection to name — a pipeline, a remote, an integration handler — keeps both absent rather
 * than carrying an invented one.
 */
export class AuthoredRefusal extends Schema.TaggedError<AuthoredRefusal>()(AUTHORED_REFUSAL_TAG, {
	message: Schema.NonEmptyString,
	collection: Schema.optionalKey(Schema.NonEmptyString),
	action: Schema.optionalKey(Schema.NonEmptyString)
}) {
	readonly category = 'refused' as const;
	readonly retryable = false;
}

/** Where a refusal was raised, as much of it as the catching seam knows. */
export type RefusalSite = Readonly<{
	readonly collection?: string;
	readonly action?: string;
}>;

const named = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * The refusal a thrown value carries, or `undefined` if it carries none.
 *
 * Normalising rather than returning the caught object matters: the value that arrives may be an
 * `AuthoredRefusal` from a *different* module instance (see `AUTHORED_REFUSAL_TAG`), and everything
 * downstream — the `instanceof` in `runtime/app.ts`, the error channel's type — is written against
 * this module's class. So a recognised refusal is rebuilt here, and what comes back is always one
 * this package can reason about.
 */
export const refusalOf = (cause: unknown): AuthoredRefusal | undefined => {
	if (cause === null || typeof cause !== 'object') return undefined;
	if (Reflect.get(cause, '_tag') !== AUTHORED_REFUSAL_TAG) return undefined;
	const message = named(Reflect.get(cause, 'message'));
	if (message === undefined) return undefined;
	if (cause instanceof AuthoredRefusal) return cause;
	const collection = named(Reflect.get(cause, 'collection'));
	const action = named(Reflect.get(cause, 'action'));
	return new AuthoredRefusal({
		message,
		...(collection === undefined ? {} : { collection }),
		...(action === undefined ? {} : { action })
	});
};

/**
 * Stamps the site a refusal was raised at, without overwriting one it already carries.
 *
 * A hook that refuses on behalf of another collection — `payslips` refusing because its
 * `payroll_runs` row is settled — has already said which collection the rule belongs to, and the
 * outer seam must not relabel it with whichever table the write happened to land on.
 */
export const refusalAt = (refusal: AuthoredRefusal, site: RefusalSite): AuthoredRefusal => {
	const collection = refusal.collection ?? named(site.collection);
	const action = refusal.action ?? named(site.action);
	if (collection === refusal.collection && action === refusal.action) return refusal;
	return new AuthoredRefusal({
		message: refusal.message,
		...(collection === undefined ? {} : { collection }),
		...(action === undefined ? {} : { action })
	});
};

/**
 * Refuses the operation in progress with a sentence a person can read.
 *
 * It **throws**, and that is load bearing rather than incidental. Every authored call site in this
 * tree spells it as a bare statement inside an `if` — nothing yields it, nothing returns it — so a
 * `refuse` that *returned* an `Effect.fail` would construct a failure, drop it, fall out of the
 * `if`, and let the write proceed. That change would disable every business rule in the workspace
 * without a type error, a lint finding or a failing test. Throwing keeps `refuse(message);` working
 * exactly as written, and `return yield* refuse(message)` too: the throw happens while the argument
 * is being evaluated, long before `yield*` sees anything.
 *
 * What changed is not how it is called but where it lands. The thrown value is a tagged refusal,
 * and the runtime seams that invoke authored code convert it into the error channel instead of
 * letting it die as a defect.
 */
const DeclarationRefusals = {
	refuse: (message: string): never => {
		// `message` is `NonEmptyString`, so an empty sentence would make the constructor itself throw
		// a schema error and replace the author's refusal with "Schema validation failed" — the same
		// trap `DispatchError.from` documents. An author who called `refuse()` with nothing still
		// meant to refuse, so the refusal survives and only the sentence is substituted.
		throw new AuthoredRefusal({
			message: named(message) ?? 'This operation was refused by a workspace rule.'
		});
	}
};

/**
 * Refuses the operation, and is declared to return `never` explicitly.
 *
 * The annotation is load-bearing, not decoration. TypeScript only treats a call as terminating
 * control flow when the callee is an identifier carrying an **explicit** return type, so without it
 * `if (value == null) refuse('…')` narrows nothing and every use below the guard is
 * `possibly undefined`. The emitted `.d.ts` infers one, which is why a workspace compiling against
 * the published build behaved differently from one compiling against these sources — 32 phantom
 * errors in a single template, none of them the template's fault.
 */
export const refuse: (message: string) => never = DeclarationRefusals.refuse;
