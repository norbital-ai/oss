import { Schema } from 'effect';

/** An author error; `line` (1-based) when the checker names one. */
export const Diagnostic = Schema.Struct({
	code: Schema.String,
	path: Schema.String,
	line: Schema.optionalKey(Schema.Number),
	message: Schema.String,
	help: Schema.optionalKey(Schema.String)
});
export type CheckDiagnostic = {
	-readonly [K in keyof typeof Diagnostic.Type]: (typeof Diagnostic.Type)[K];
};
