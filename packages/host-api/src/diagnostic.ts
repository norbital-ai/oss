// A release's build diagnostics, as Studio shows them.
import { Schema } from 'effect';

/** An author error; `line` (1-based) when the checker names one. */
export const Diagnostic = Schema.Struct({
	code: Schema.String,
	path: Schema.String,
	line: Schema.optionalKey(Schema.Number),
	message: Schema.String,
	help: Schema.optionalKey(Schema.String)
});
/** An author error as Studio shows it (`Diagnostic`), mutable for the checker that fills it. */
export type CheckDiagnostic = {
	-readonly [K in keyof typeof Diagnostic.Type]: (typeof Diagnostic.Type)[K];
};
