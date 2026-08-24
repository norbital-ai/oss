import { Environment } from '@marcbachmann/cel-js';
import { Effect, Option, Schema } from 'effect';

/**
 * How a record reads as a name — the other half of `CollectionDefinition.recordLabel`.
 *
 * The declaration already lives in this package, so its evaluation belongs beside it: a surface
 * that has a `CollectionDefinition` in hand and wants the record's title should not have to reach
 * into a transport package to learn how the expression it is holding is meant to be read. Both the
 * table and the kanban card do exactly that, and both are pure view code.
 *
 * CEL is the language because that is what the compiler emits into the manifest. Its evaluator is
 * private to the collection contract, so record labels do not create a second general CEL surface.
 */

const celEnvironment = (() => {
	const env = new Environment({
		unlistedVariablesAreDyn: true,
		homogeneousAggregateLiterals: false
	});

	const reduceValues = (values: unknown[], expression: unknown, initial: unknown): unknown => {
		const expr = String(expression ?? 'acc');
		let acc: unknown = initial;
		for (let index = 0; index < values.length; index += 1) {
			const item = values[index];
			acc = env.evaluate(expr, { acc, item, index, list: values });
		}
		return acc;
	};

	env.registerFunction('reduce(list<dyn>, string, dyn): dyn', (values, expression, initial) => {
		if (!Array.isArray(values)) return initial;
		return reduceValues(values, expression, initial);
	});
	env.registerFunction(
		'reduce(map<string, dyn>, string, dyn): dyn',
		(values, expression, initial) => {
			if (values === null || typeof values !== 'object' || Array.isArray(values)) return initial;
			return reduceValues(Object.values(values), expression, initial);
		}
	);
	env.registerFunction('toDouble(dyn): double', (value: unknown) => {
		if (typeof value === 'number') return value;
		if (typeof value === 'string') {
			const parsed = parseFloat(value);
			return Number.isNaN(parsed) ? 0.0 : parsed;
		}
		return 0.0;
	});
	env.registerFunction('has(dyn, string): bool', (obj: unknown, field: unknown) => {
		if (obj === null || typeof obj !== 'object') return false;
		return Object.prototype.hasOwnProperty.call(obj, String(field ?? ''));
	});
	return env;
})();

function evaluateCelExpression(expr: string, context: unknown): unknown {
	const data =
		context == null
			? {}
			: typeof context !== 'object' || Array.isArray(context)
				? { value: context }
				: Object.fromEntries(Object.entries(context));
	return celEnvironment.evaluate(expr, data);
}

/** Separator the schema builder compiles between the fields of a multi-field record label. */
const LABEL_TERM_SEPARATOR = ' · ';
/** The compiled join, as `modelTableMeta` emits it: `<term> + ' · ' + <term>`. */
const LABEL_TERM_JOIN = /\s\+\s'\s·\s'\s\+\s/;

/**
 * An opaque identifier, which must never be shown to a person as the name of a record.
 *
 * Matching on the *value* rather than the column name is the honest test: a column called
 * `employee_id` may well hold a payroll number worth reading, while `employment_id` holds a uuid
 * that means nothing to anyone. What disqualifies a value is being an identifier, not being called
 * one.
 */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cheap gate before the parse, so ordinary prose never pays for it. */
const JSON_SHAPED = /^[{[][\s\S]*[}\]]$/;

/** A JSON object or array, which is never a title — the values inside are irrelevant. */
const JsonContainerSchema = Schema.Union([
	Schema.Record(Schema.String, Schema.Unknown),
	Schema.Array(Schema.Unknown)
]);
const JsonContainerDecoded = Schema.decodeOption(Schema.fromJsonString(JsonContainerSchema));

/**
 * Render one label term as text, or null when it has nothing to contribute.
 *
 * CEL cannot do this itself. Its `+` has no overload but string+string, and `string()` has no
 * overload for timestamps or null — so a label naming a day-precision `instant()` column, a number,
 * a boolean or an empty field throws instead of concatenating, however the expression is written.
 * Coercion therefore belongs here, where the values are ordinary JavaScript and a missing one can
 * simply be left out.
 */
export function labelTermText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		const iso = value.toISOString();
		// Locale-independent on purpose: these labels are also built server-side, for approval
		// requests and audit subjects, where there is no viewer whose locale could be consulted.
		return iso.endsWith('T00:00:00.000Z')
			? iso.slice(0, 10)
			: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	}
	// A relation payload, an array or a JSON blob is not a title. A `custom()` JSONB column named as
	// a record label can never produce one, and no coercion changes that — so it contributes
	// nothing and the caller degrades to the placeholder, rather than printing `{"status":"OK"}`
	// or, worse, falling through to a scan that puts a foreign key on screen.
	if (typeof value === 'object') return null;
	const text = String(value).trim();
	if (!text || UUID_SHAPED.test(text)) return null;
	// The same blob, after a round trip through JSONB, arrives as its own serialization. The bracket
	// gate alone is not proof — prose can open with one — so only an actual parse decides; the parsed
	// value is inspected and discarded, what it holds is irrelevant, only that it is a container.
	if (JSON_SHAPED.test(text) && Option.isSome(JsonContainerDecoded(text))) return null;
	return text;
}

/**
 * Evaluate one label expression against a record, or yield null when it cannot be evaluated.
 *
 * A throw is an ordinary outcome here rather than a fault: CEL raises on a type it has no overload
 * for, and the caller's whole point is to fall back to the terms that did produce something.
 */
function evaluateLabelExpression(expression: string, record: object): unknown {
	return Effect.runSync(
		Effect.try(() => evaluateCelExpression(expression, { scope: { record } })).pipe(
			Effect.orElseSucceed(() => null)
		)
	);
}

/**
 * The title a record reads as, from the CEL expression its collection declares as `recordLabel`.
 *
 * Null means the record cannot name itself — no expression, or nothing the expression touched had
 * any text to give. A caller decides what to show instead; this never invents a stand-in, and in
 * particular never falls back to a primary key.
 */
export function resolveRecordLabel(
	recordLabelExpression: string | null,
	record: object
): string | null {
	if (!recordLabelExpression) return null;
	// One set of rules, whichever path produced the text: an expression that evaluated cleanly to a
	// uuid or to a serialized JSON blob is no more a title than the same value reached term by term.
	const whole = labelTermText(evaluateLabelExpression(recordLabelExpression, record));
	if (whole) return whole;

	// The whole expression could not produce a string. For the compiled multi-field form that is
	// the norm rather than the exception — one non-string or null term is enough to throw the
	// entire concatenation — so evaluate the terms separately and join whatever survives. A single
	// empty field now costs its own term instead of the whole title, and with it the fallback that
	// used to put a uuid on screen. A single-field label splits to one term, which is the same
	// evaluation as `whole`, so this also covers `recordLabel: 'work_date'` — a value that was never
	// a string to begin with.
	const texts: string[] = [];
	for (const term of recordLabelExpression.split(LABEL_TERM_JOIN)) {
		const text = labelTermText(evaluateLabelExpression(term, record));
		if (text !== null) texts.push(text);
	}
	return texts.length > 0 ? texts.join(LABEL_TERM_SEPARATOR) : null;
}
