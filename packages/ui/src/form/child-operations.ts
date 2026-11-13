import { Schema } from 'effect';
import { Decimal } from '@norbital-ai/store/decimal';
import type { Value } from '@norbital-ai/store/kind';
import type { Values } from '../model/types.js';

/** Explicit native commands only: an absent or unloaded row never means delete. */
export type ChildOperation = (
	| { action: 'create'; values: Values }
	| { action: 'update'; id: string; revision: number; set: Values }
	| { action: 'delete' | 'link' | 'unlink'; id: string; revision: number }
) & { proposal?: true };

const ValueSchema: Schema.Decoder<Value> = Schema.suspend(() =>
	Schema.Union([
		Schema.Null,
		Schema.Boolean,
		Schema.Finite,
		Schema.String,
		Schema.declare((value: unknown): value is Decimal => value instanceof Decimal),
		Schema.Array(ValueSchema),
		Schema.Record(Schema.String, ValueSchema)
	])
);
const ValuesSchema = Schema.Record(Schema.String, ValueSchema);
const proposal = Schema.optionalKey(Schema.Literal(true));
/** A stored draft's child operation (revived with `revive_wire`), decoded before it re-enters a form. */
export const ChildOperationSchema: Schema.Decoder<ChildOperation> = Schema.Union([
	Schema.Struct({ action: Schema.Literal('create'), values: ValuesSchema, proposal }),
	Schema.Struct({ action: Schema.Literal('update'), id: Schema.String, revision: Schema.Number, set: ValuesSchema, proposal }),
	Schema.Struct({ action: Schema.Literals(['delete', 'link', 'unlink']), id: Schema.String, revision: Schema.Number, proposal })
]);

export function childOperations(
	commands: Readonly<Record<string, readonly ChildOperation[]>>,
	mode: 'create' | 'update'
): {
	set: Record<string, Value>;
} {
	const set: Record<string, Value> = {};
	for (const [relation, operations] of Object.entries(commands)) {
		const actions: Record<string, Value[]> = {};
		for (const operation of operations) {
			const value =
				operation.action === 'create'
					? operation.values
					: operation.action === 'update'
						? { target: { id: operation.id, revision: operation.revision }, set: operation.set }
						: { id: operation.id, revision: operation.revision };
			(actions[operation.action] ??= []).push(value);
			if (operation.action !== 'create') {
				if (!Number.isSafeInteger(operation.revision) || operation.revision < 1)
					throw new Error('A child operation needs its original revision.');
			}
		}
		if (mode === 'create') {
			if (operations.some((operation) => operation.action !== 'create' && operation.action !== 'link'))
				throw new Error('A new parent creates or links its children.');
			if (operations.length > 0) set[relation] = operations.map((operation) => operation.action === 'create'
				? operation.values : { id: operation.id, revision: operation.revision });
		} else if (Object.keys(actions).length > 0) set[relation] = actions;
	}
	return { set };
}
