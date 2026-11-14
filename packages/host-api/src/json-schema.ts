// The JSON Schema a model is offered for a Schema: closed, without model-facing noise. Decoding stays with the Schema.
import { Schema } from 'effect';

import type { Json } from '@norbital-ai/store';

const NON_FINITE = '["Infinity","-Infinity","NaN"]';
/** A key filter JSON Schema cannot express leaves `anyOf: [..., { type: 'string' }]`, which admits every name. */
const anyString = (names: unknown) =>
	typeof names === 'object' &&
	names !== null &&
	'anyOf' in names &&
	Array.isArray(names.anyOf) &&
	names.anyOf.some((branch) => JSON.stringify(branch) === '{"type":"string"}');
/**
 * Model-facing noise only: safe-integer bounds, the JSON codec's non-finite string branch and no-op key names. Decoding
 * stays with the Schema. A JSON Schema document holds only JSON values; anything else (never emitted) reads as null.
 */
const compact = (node: unknown): Json => {
	if (Array.isArray(node)) return node.map(compact);
	if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node;
	if (typeof node !== 'object') return null;
	const out: { [key: string]: Json } = {};
	for (const [key, value] of Object.entries(node))
		if (
			value !== undefined &&
			!(key === 'minimum' && value === Number.MIN_SAFE_INTEGER) &&
			!(key === 'maximum' && value === Number.MAX_SAFE_INTEGER) &&
			!(key === 'propertyNames' && anyString(value))
		)
			out[key] = compact(value);
	const [finite, nonFinite, ...more] = Array.isArray(out['anyOf']) ? out['anyOf'] : [];
	if (
		more.length === 0 &&
		typeof finite === 'object' &&
		finite !== null &&
		!Array.isArray(finite) &&
		JSON.stringify(nonFinite) === `{"type":"string","enum":${NON_FINITE}}`
	) {
		const { anyOf: _, ...rest } = out;
		return { ...finite, ...rest };
	}
	return out;
};
/** Closed model-facing schemas share one encoder; decision responses retain their explicit empty definitions. */
export const model_schema = (schema: Schema.Constraint, keepEmptyDefinitions = false): Json => {
	const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' });
	return compact(
		keepEmptyDefinitions || Object.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	);
};
