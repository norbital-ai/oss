import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationBinding } from '../src/authoring/integration-introspection.js';
import {
	absorbRecords,
	type AbsorbDependencies,
	type AbsorbTarget
} from '../src/runtime/integrations/absorb.js';

/**
 * Running the same delivery twice, when one source record becomes several rows.
 *
 * A mirror's whole contract is that absorbing the same records again leaves the same rows. Fan-out is
 * where that quietly stopped being true: the identity lookup answered with one row per external key,
 * so every row after the first was invisible to it and arrived as a `create` for an id it had already
 * written. Nothing failed loudly — the collection just grew on every run.
 *
 * The second property is the one the shape of a fan-out forces: it is a *set*. A record that expanded
 * into three rows and now expands into two has to lose one, or the row that no longer corresponds to
 * anything upstream survives forever.
 */

/** A store that behaves like a collection: rows by id, and a reverse index on the identity column. */
const store = () => {
	const rows = new Map<string, Readonly<Record<string, Schema.Json>>>();
	const modes: Array<'create' | 'update'> = [];
	const removed: Array<string> = [];
	const dependencies: AbsorbDependencies = {
		existing: (_effectId, _collection, column, keys) =>
			Effect.succeed(
				new Map(
					keys.map((key) => [
						key,
						[...rows.entries()]
							.flatMap(([id, values]) => (values[column] === key ? [id] : []))
							.sort()
					])
				)
			),
		remove: (_effectId, _collection, ids) => {
			for (const id of ids) {
				rows.delete(id);
				removed.push(id);
			}
			return Effect.succeed(undefined);
		},
		write: (_effectId, _collection, id, values, mode) => {
			modes.push(mode);
			rows.set(id, values);
			return Effect.succeed(undefined);
		},
		pipeline: undefined as unknown as AbsorbDependencies['pipeline'],
		resolve: () => Effect.fail({ message: 'this binding declares no resolve' })
	};
	return { rows, modes, removed, dependencies };
};

const target: AbsorbTarget = {
	integration: 'items.source',
	binding: 'daily',
	collection: 'lines',
	identityColumn: 'external_id'
};

const authored: AuthoredIntegrationBinding = {
	input: Schema.Unknown,
	identityColumn: 'external_id',
	identityValue: (record) => String(Reflect.get(record as object, 'id'))
};

/** One source record fanning out into `width` rows, the way an import pipeline does. */
const fanOut =
	(width: number): AbsorbDependencies['pipeline'] =>
	(_effectId, _collection, record) =>
		Effect.succeed(
			Array.from({ length: width }, (_unused, line) => ({
				external_id: String(Reflect.get(record as object, 'id')),
				line,
				note: `line ${line}`
			}))
		);

const absorb = (dependencies: AbsorbDependencies, records: ReadonlyArray<unknown>) =>
	Effect.runPromise(
		absorbRecords(dependencies, EffectId.make('absorb-test'), target, authored, records, 0, 50)
	);

describe('absorbing a record that fans out into several rows', () => {
	it('writes the same rows again rather than duplicating them', async () => {
		const harness = store();
		const dependencies = { ...harness.dependencies, pipeline: fanOut(3) };

		const first = await absorb(dependencies, [{ id: 'a' }]);
		expect(harness.rows.size).toBe(3);
		expect(first.created).toBe(1);
		expect(first.updated).toBe(0);

		const second = await absorb(dependencies, [{ id: 'a' }]);
		// The whole point: three rows before, three rows after. This was 6, then 9, then 12.
		expect(harness.rows.size).toBe(3);
		expect(second.created).toBe(0);
		expect(second.updated).toBe(1);
		// And the second run addressed them as updates, not as new rows.
		expect(harness.modes.slice(3)).toEqual(['update', 'update', 'update']);
	});

	it('removes the rows a narrower fan-out no longer produces', async () => {
		const harness = store();
		await absorb({ ...harness.dependencies, pipeline: fanOut(4) }, [{ id: 'a' }]);
		expect(harness.rows.size).toBe(4);

		await absorb({ ...harness.dependencies, pipeline: fanOut(2) }, [{ id: 'a' }]);
		// Replace-the-set: the two rows the source stopped sending are gone, not orphaned.
		expect(harness.rows.size).toBe(2);
		expect(harness.removed).toHaveLength(2);
	});

	it('grows when the fan-out widens', async () => {
		const harness = store();
		await absorb({ ...harness.dependencies, pipeline: fanOut(2) }, [{ id: 'a' }]);
		await absorb({ ...harness.dependencies, pipeline: fanOut(5) }, [{ id: 'a' }]);
		expect(harness.rows.size).toBe(5);
		expect(harness.removed).toEqual([]);
	});

	it('counts the source record once, however many rows it becomes', async () => {
		const harness = store();
		const outcome = await absorb({ ...harness.dependencies, pipeline: fanOut(7) }, [
			{ id: 'a' },
			{ id: 'b' }
		]);
		// Two records absorbed, fourteen rows written. Reporting fourteen would make the number mean
		// something different depending only on how the binding maps.
		expect(outcome.created).toBe(2);
		expect(harness.rows.size).toBe(14);
	});

	it('keeps records independent of each other', async () => {
		const harness = store();
		const dependencies = { ...harness.dependencies, pipeline: fanOut(2) };
		await absorb(dependencies, [{ id: 'a' }, { id: 'b' }]);
		expect(harness.rows.size).toBe(4);

		// Re-absorbing only `a` must not disturb `b`'s rows — the prune is scoped to the record it ran for.
		await absorb(dependencies, [{ id: 'a' }]);
		expect(harness.rows.size).toBe(4);
		expect(harness.removed).toEqual([]);
	});
});
