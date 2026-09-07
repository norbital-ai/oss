import { Schema } from 'effect';
import { predicateStatement, type RowPredicate } from './predicate.js';

/** Stable, JSON-safe source material for a query's policy component. */
export type PolicyHashSource = Readonly<{
	readonly action: string;
	readonly resource: string;
	readonly allowed: boolean;
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
	readonly fields: ReadonlyArray<string> | null;
}>;

/**
 * The workspace's own predicate: every row, every field, no live authorization, no approval route.
 *
 * It answers the workspace subject inside a write (what a hook reads, returns or writes) and the
 * insert statements of a committed graph, whose rows were already judged when the graph was
 * prepared.
 */
export const unrestricted: RowPredicate = {
	allowed: true,
	reason: 'workspace',
	expression: { kind: 'constant', value: true },
	actorBound: false
};

/** The exact stable material a sync registration hashes for one policy coordinate. */
export const policyHashSource = (
	action: string,
	resource: string,
	predicate: RowPredicate
): PolicyHashSource => {
	const statement = predicateStatement(predicate);
	return {
		action,
		resource,
		allowed: predicate.allowed,
		sql: statement.sql,
		parameters: statement.parameters,
		fields: predicate.fields === undefined ? null : [...new Set(predicate.fields)].toSorted()
	};
};

/** Applies only the field grant already carried by a compiled predicate. */
export const maskWithPredicate = (
	predicate: RowPredicate,
	action: string,
	value: Readonly<Record<string, Schema.Json>>
): Readonly<Record<string, Schema.Json>> => {
	if (!predicate.allowed) return {};
	if (predicate.fields === undefined) return value;
	return Object.fromEntries(
		Object.entries(value).filter(
			([field]) =>
				predicate.fields?.includes(field) ||
				(action === 'read' && (field === 'id' || field === 'row_version'))
		)
	);
};
