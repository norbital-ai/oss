// std/facts (§3.7): runtime-declared fields. An administrator declares the keys a record may carry (a jurisdiction's
// statutory facts, an intake form's questions) as rows; the record stores the values in one `json` field, and the
// collection's transform validates them with `validateFacts`. `facts` checks the declarations themselves.

/** One declared key, as stored (a `json` row or a seed file). */
export type FactSpec = {
	readonly key: string;
	readonly type: 'boolean' | 'number' | 'string';
	readonly label?: string | null;
	readonly description?: string | null;
	/** Required on a complete record; an incomplete one may still be saved. */
	readonly required?: boolean | null;
	/** A documented default; omission is not a declaration. */
	readonly default_value?: boolean | number | string | null;
	readonly options?: readonly (boolean | number | string)[] | null;
	readonly minimum?: number | null;
	readonly maximum?: number | null;
	readonly integer?: boolean | null;
	readonly min_length?: number | null;
};

const nameOf = (s: FactSpec) => s.label?.trim() || s.key;

function valueFault(s: FactSpec, v: unknown): string | null {
	const name = nameOf(s);
	if (typeof v !== s.type) return `${name} must be a ${s.type}; this value is a ${typeof v}.`;
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return `${name} must be finite.`;
		if (s.integer && !Number.isInteger(v)) return `${name} must be a whole number.`;
		if (s.minimum != null && v < s.minimum) return `${name} must be at least ${s.minimum}.`;
		if (s.maximum != null && v > s.maximum) return `${name} must be at most ${s.maximum}.`;
	}
	if (typeof v === 'string' && s.min_length != null && v.trim().length < s.min_length) return `${name} must contain at least ${s.min_length} characters.`;
	if (s.options != null && !s.options.some((o) => o === v)) return `${name} must be one of: ${s.options.join(', ')}.`;
	return null;
}

/** The declarations, checked: keys are identifiers and unique, constraints fit the type, options and default are valid values. Throws the first fault. */
export function facts(specs: readonly FactSpec[]): readonly FactSpec[] {
	const seen = new Set<string>();
	for (const s of specs) {
		const fault = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.key) ? 'a key is a letter or underscore, then letters, digits or underscores'
			: seen.has(s.key) ? 'each key is declared once'
			: s.type !== 'number' && (s.minimum != null || s.maximum != null || s.integer != null) ? 'numeric constraints require a number fact'
			: s.type !== 'string' && s.min_length != null ? 'a minimum length requires a string fact'
			: s.minimum != null && s.maximum != null && s.minimum > s.maximum ? 'the minimum exceeds the maximum'
			: s.required && s.default_value != null ? 'a fact is required or has a default, not both'
			: s.options != null && (s.options.length === 0 || new Set(s.options).size !== s.options.length) ? 'options are nonempty and unique'
			: s.options?.map((o) => valueFault({ ...s, options: null }, o)).find((f) => f !== null)
				?? (s.default_value == null ? null : valueFault(s, s.default_value));
		if (fault) throw new Error(`${s.key}: ${fault}`);
		seen.add(s.key);
	}
	return specs;
}

/**
 * The first fault of `values` against `specs`, or null: an undeclared key, a value of the wrong type or outside its
 * constraints, and (with `complete`) a required fact that is missing or blank. A transform refuses with the message.
 */
export function validateFacts(specs: readonly FactSpec[], values: { readonly [key: string]: unknown }, o: { complete?: boolean } = {}): string | null {
	const declared = new Map(specs.map((s) => [s.key, s]));
	for (const key of Object.keys(values)) if (!declared.has(key)) return `${key} is not a declared fact.`;
	for (const s of specs) {
		const v = values[s.key];
		if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
			if (o.complete && s.required) return `${nameOf(s)} is required.`;
			continue;
		}
		const fault = valueFault(s, v);
		if (fault !== null) return fault;
	}
	return null;
}
