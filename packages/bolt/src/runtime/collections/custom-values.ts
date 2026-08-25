import { Result, type Schema } from 'effect';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';

/**
 * Checks `custom()` column values against the schema their type declares.
 *
 * A `custom('leave_event')` column advertises a closed union, but a write decoded its values as
 * arbitrary JSON — so a value of the wrong shape was stored rather than refused. The damage surfaced
 * far from the cause: columns generated from the value read null and a table rendered dashes, with
 * nothing anywhere reporting an error.
 *
 * This returns a message rather than a failure of its own. The one place that needs it is the
 * command boundary, where a malformed value is exactly what `invalid_input` already means — so no
 * new error type is introduced and no service's failure channel widens to carry one.
 *
 * Validation goes through the Standard Schema interface, the same seam authored remotes are already
 * validated through, so nothing here depends on the schema library an author chose.
 */

type StandardIssue = Readonly<{
	readonly message?: string;
	readonly path?: ReadonlyArray<unknown>;
}>;
type StandardResult = Readonly<{ readonly issues?: ReadonlyArray<StandardIssue> }>;

const validatorOf = (
	definition: unknown,
	options: Readonly<Record<string, Schema.Json>> | undefined
	// repository-health:allow EFF2 -- Standard Schema validators may return a Promise by specification; this boundary detects that result and never composes it as native concurrency.
): ((value: unknown) => StandardResult | Promise<StandardResult>) | undefined => {
	if (definition === null || typeof definition !== 'object') return undefined;
	let schema = Reflect.get(definition, 'schema');
	// A factory is told apart by the *absence of `~standard`*, not by being callable: an Effect
	// `Schema` is itself callable, so testing
	// `typeof schema === 'object'` read every Effect-declared custom type as a factory and skipped its
	// validation in silence — a value of the wrong shape was stored and nothing reported anything,
	// which is the exact failure this module exists to stop.
	if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function'))
		return undefined;
	let standard = Reflect.get(schema, '~standard');
	if ((standard === null || typeof standard !== 'object') && typeof schema === 'function') {
		const factoryOptions = Object.fromEntries(
			Object.entries(options ?? {}).filter(([key]) => key !== 'multiple')
		);
		const created = Result.try(() => Reflect.apply(schema, undefined, [factoryOptions]));
		if (Result.isFailure(created)) return undefined;
		schema = created.success;
		if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function'))
			return undefined;
		standard = Reflect.get(schema, '~standard');
	}
	if (standard === null || typeof standard !== 'object') return undefined;
	const validate = Reflect.get(standard, 'validate');
	return typeof validate === 'function'
		? (value: unknown) => validate.call(standard, value)
		: undefined;
};

const describe = (
	field: string,
	customType: string,
	issues: ReadonlyArray<StandardIssue>
): string => {
	const detail = issues
		.map((issue) => {
			const path = (issue.path ?? []).map(String).join('.');
			const message = issue.message ?? 'is invalid';
			return path === '' ? message : `${path}: ${message}`;
		})
		.join('; ');
	return `${field} is not a valid ${customType}: ${detail === '' ? 'it does not match the declared schema' : detail}`;
};

/**
 * Returns why a write is invalid, or `undefined` when every custom value it carries is fine.
 *
 * Only columns the write actually sets are checked — a partial update names a subset, and requiring
 * absent columns to validate would reject an update for a field it never touched. A `null` is passed
 * to the schema rather than skipped, because whether null is allowed is the schema's decision.
 */
export const describeInvalidCustomValue = (
	fields: Readonly<Record<string, FieldDefinition>>,
	values: Readonly<Record<string, Schema.Json>>,
	customTypes: Readonly<Record<string, unknown>> | undefined
): string | undefined => {
	if (customTypes === undefined) return undefined;

	for (const [field, definition] of Object.entries(fields)) {
		const customType = definition.customType;
		if (customType === undefined || !Object.hasOwn(values, field)) continue;

		const validate = validatorOf(customTypes[customType], definition.customTypeOptions);
		if (validate === undefined) continue;

		const value = values[field] ?? null;
		const multiple = definition.customTypeOptions?.['multiple'] === true;
		if (multiple && !Array.isArray(value))
			return `${field} is not a valid ${customType}: expected an array because multiple is enabled`;
		const entries = multiple ? (value as ReadonlyArray<Schema.Json>) : [value];
		for (const [index, entry] of entries.entries()) {
			const result = validate(entry);
			// A promise means an asynchronous schema; it is left unchecked rather than stalling a write.
			if (result instanceof Promise) continue;
			if (result.issues !== undefined && result.issues.length > 0)
				return describe(multiple ? `${field}[${index}]` : field, customType, result.issues);
		}
	}

	return undefined;
};

/**
 * Names a generated column an explicit edit tried to set.
 *
 * `writableValues` drops these before the statement, which is right for its original callers — an
 * import, a seed or an optimistic mutation echoes a whole row back and would otherwise fail on a
 * column it never chose to set. It is wrong for someone editing one field: the write returned
 * `{updated: true}` and the value silently stayed as it was.
 *
 * The distinction is the caller, not the column, so this is called from the command boundary where
 * an explicit edit is distinguishable from a row echo, and reported through `invalid_input` like any
 * other input the caller got wrong.
 */
export const describeGeneratedColumnWrite = (
	fields: Readonly<Record<string, FieldDefinition>>,
	values: Readonly<Record<string, Schema.Json>>
): string | undefined => {
	const generated = Object.entries(fields)
		.filter(([name, field]) => field.generated !== undefined && Object.hasOwn(values, name))
		.map(([name]) => name);
	if (generated.length === 0) return undefined;
	return `${generated.join(', ')} ${generated.length === 1 ? 'is a generated column and cannot be written' : 'are generated columns and cannot be written'}; the database computes ${generated.length === 1 ? 'it' : 'them'}.`;
};
