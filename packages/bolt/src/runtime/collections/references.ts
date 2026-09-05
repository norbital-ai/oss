import { Result, Schema } from 'effect';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import { RECORD_EMBEDDING_COLUMN } from '#lib/authoring/model-introspection.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isString = Schema.is(Schema.String);
const isFiniteNumber = (value: unknown): boolean =>
	Schema.is(Schema.Number)(value) && Number.isFinite(value);
const LogicalReference = Schema.Struct({ kind: Schema.String, id: Schema.String });
const decodeLogicalReference = Schema.decodeUnknownResult(LogicalReference);

/** PostgreSQL's wire representation for pgvector is its JSON-shaped text literal. */
const isVectorField = (field: FieldDefinition | undefined): boolean =>
	field?.sqlType?.toLowerCase().startsWith('vector(') === true;

/** Restores the public `readonly number[]` contract from pgvector's text wire value. */
const decodeVectorValue = (field: string, value: unknown): unknown => {
	if (value == null) return value;
	const decoded =
		isString(value)
			? (() => {
					try {
						return JSON.parse(value) as unknown;
					} catch {
						/* best effort */
						return undefined;
					}
				})()
			: value;
	if (
		Array.isArray(decoded) &&
		decoded.length > 0 &&
		decoded.every((entry) => isFiniteNumber(entry))
	)
		return decoded;
	throw new Error(
		`Vector integrity violation: "${field}" is not a non-empty array of finite numbers.`
	);
};

const referenceFields = (fields: Readonly<Record<string, FieldDefinition>>) =>
	Object.entries(fields).filter(
		(
			entry
		): entry is [
			string,
			FieldDefinition & { readonly reference: NonNullable<FieldDefinition['reference']> }
		] => entry[1].reference !== undefined
	);

/** Returns the authored refusal message for a malformed logical handle, if one is present. */
export const referenceValueProblem = (
	values: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDefinition>>
): string | undefined => {
	for (const [fieldName, field] of referenceFields(fields)) {
		if (!Object.hasOwn(values, fieldName)) continue;
		const value = values[fieldName];
		if (value === null) {
			if (field.required) return `Reference "${fieldName}" is required and cannot be null.`;
			continue;
		}
		const decoded = decodeLogicalReference(value);
		if (Result.isFailure(decoded))
			return `Reference "${fieldName}" must be one { kind, id } object.`;
		if (!field.reference.targets.some((target) => target.tag === decoded.success.kind))
			return `Reference "${fieldName}" has unknown kind ${JSON.stringify(decoded.success.kind)}. Expected one of: ${field.reference.targets.map((target) => target.tag).join(', ')}.`;
		if (!UUID.test(decoded.success.id)) return `Reference "${fieldName}" id must be a UUID.`;
	}
	return undefined;
};

/** Expands logical handles to their hidden exclusive-arc UUID columns before SQL is generated. */
export const encodeReferenceValues = (
	values: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Readonly<Record<string, unknown>> => {
	const problem = referenceValueProblem(values, fields);
	if (problem !== undefined) throw new TypeError(problem);
	const encoded: Record<string, unknown> = { ...values };
	for (const [fieldName, field] of referenceFields(fields)) {
		if (!Object.hasOwn(values, fieldName)) continue;
		const value = values[fieldName];
		delete encoded[fieldName];
		for (const target of field.reference.targets) encoded[target.storageColumn] = null;
		if (value === null) continue;
		const decoded = Schema.decodeUnknownSync(LogicalReference)(value);
		const selected = field.reference.targets.find((target) => target.tag === decoded.kind);
		if (selected !== undefined) encoded[selected.storageColumn] = decoded.id;
	}
	return encoded;
};

/** Collapses reference arms and restores database vector text to the public row value. */
export function decodeReferenceRow(
	row: Readonly<Record<string, Schema.Json>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Readonly<Record<string, Schema.Json>>;
export function decodeReferenceRow(
	row: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Readonly<Record<string, unknown>>;
export function decodeReferenceRow(
	row: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Readonly<Record<string, unknown>> {
	const decoded: Record<string, unknown> = { ...row };
	for (const [fieldName, field] of Object.entries(fields)) {
		if (isVectorField(field) && Object.hasOwn(row, fieldName))
			decoded[fieldName] = decodeVectorValue(fieldName, row[fieldName]);
	}
	// The platform-owned embedding is not an authored field, but it shares the same public vector
	// contract whenever a collection declares record embedding and the query selected the column.
	if (Object.hasOwn(row, RECORD_EMBEDDING_COLUMN))
		decoded[RECORD_EMBEDDING_COLUMN] = decodeVectorValue(
			RECORD_EMBEDDING_COLUMN,
			row[RECORD_EMBEDDING_COLUMN]
		);
	for (const [fieldName, field] of referenceFields(fields)) {
		const alreadyLogical = Object.hasOwn(row, fieldName);
		const selected = field.reference.targets.filter((target) => {
			const value = row[target.storageColumn];
			delete decoded[target.storageColumn];
			return value != null;
		});
		if (alreadyLogical) continue;
		if (selected.length > 1)
			throw new Error(
				`Reference integrity violation: "${fieldName}" has more than one populated target arm.`
			);
		const [target] = selected;
		if (target === undefined && field.required)
			throw new Error(
				`Reference integrity violation: required reference "${fieldName}" has no populated target arm.`
			);
		decoded[fieldName] =
			target === undefined ? null : { kind: target.tag, id: row[target.storageColumn] };
	}
	return decoded;
}
