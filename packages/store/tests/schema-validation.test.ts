import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { build, read_snapshot, schema, SchemaSpec, table } from '../src/index.ts';

const decode = Schema.decodeUnknownEffect(SchemaSpec, { onExcessProperty: 'error' });

it.effect('validates state declarations when building schema and table literals', () =>
	Effect.gen(function* () {
		const declarations = [
			schema({
				entry: table({
					fields: {
						status: { kind: 'state', initial: 'missing', states: { open: {} } }
					}
				})
			}),
			schema({
				entry: table({
					fields: {
						status: { kind: 'state', initial: 'open', states: { open: { to: ['missing'] } } }
					}
				})
			})
		];
		for (const declaration of declarations) {
			const failure = yield* Effect.flip(build(declaration));
			expect(failure.code).toBe('schema');
			expect(failure.message).toContain('entry.status');
		}
	})
);

it.effect(
	'rejects undeclared initial states and transition targets at both declaration boundaries',
	() =>
		Effect.gen(function* () {
			for (const state of [
				{ kind: 'state', initial: 'missing', states: { open: {} } },
				{ kind: 'state', initial: 'open', states: { open: { to: ['missing'] } } }
			]) {
				const declaration = {
					tables: { entry: { fields: { status: state } } },
					tz: 'UTC',
					currency: null
				};
				expect((yield* Effect.flip(decode(declaration))).message).toContain('entry.status');
				const failure = yield* Effect.flip(read_snapshot(JSON.stringify(declaration)));
				expect(failure.code).toBe('migration_invalid');
				expect(failure.message).toContain('entry.status');
			}
		})
);

it.effect('validates every top-level state independently', () =>
	Effect.gen(function* () {
		const declaration = {
			tables: {
				entry: {
					fields: {
						status: { kind: 'state', initial: 'open', states: { open: {} } },
						review: { kind: 'state', initial: 'open', states: { waiting: {} } }
					}
				}
			},
			tz: 'UTC',
			currency: null
		};
		expect((yield* Effect.flip(decode(declaration))).message).toContain(
			"'entry.review': initial 'open' is not a declared state"
		);
	})
);

it.effect(
	'accepts lock exceptions, references, inverse and through relations without forbidding nested states',
	() =>
		Effect.gen(function* () {
			const declaration = {
				tables: {
					entry: {
						fields: {
							name: { kind: 'text' },
							owner: { kind: 'ref', to: 'person', optional: true },
							status: {
								kind: 'state',
								optional: true,
								initial: 'open',
								states: {
									open: { to: ['locked'] },
									locked: { to: ['open'] },
									archived: {}
								}
							},
							payload: {
								kind: 'object',
								fields: {
									status: { kind: 'state', initial: 'open', states: { open: {} } }
								}
							}
						},
						through: { tags: { table: 'entry_tag', from: 'entry', to: 'tag' } },
						locks: {
							locked: {
								where: { status: { eq: 'locked' } },
								except: ['name', 'owner', 'status', 'children', 'tags']
							},
							archived: { where: { status: { eq: 'archived' } } }
						}
					},
					person: { fields: { name: { kind: 'text' } } },
					child: {
						fields: { entry: { kind: 'ref', to: 'entry', inverse: 'children', owned: true } }
					},
					tag: { fields: { name: { kind: 'text' } } },
					entry_tag: {
						fields: { entry: { kind: 'ref', to: 'entry' }, tag: { kind: 'ref', to: 'tag' } }
					}
				},
				tz: 'UTC',
				currency: null
			};
			expect(yield* decode(declaration)).toEqual(declaration);
			expect((yield* read_snapshot(JSON.stringify(declaration))).schema).toEqual(declaration);
		})
);

it.effect('rejects lock exceptions for missing, computed, derived and audit-only fields', () =>
	Effect.gen(function* () {
		for (const field of ['missing', 'shout', 'number', 'total', 'revision', 'name.value']) {
			const declaration = {
				tables: {
					entry: {
						audit: true,
						fields: {
							name: { kind: 'text' },
							number: { kind: 'seq' },
							total: { kind: 'count', of: 'children' },
							status: { kind: 'state', initial: 'open', states: { open: {} } }
						},
						computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } },
						locks: { closed: { where: { status: { eq: 'open' } }, except: [field] } }
					}
				},
				tz: 'UTC',
				currency: null
			};
			expect((yield* Effect.flip(decode(declaration))).message).toContain(
				`unknown or unwritable field or relation '${field}'`
			);
		}
	})
);

it.effect('refuses retired deletion options instead of silently changing referential actions', () =>
	Effect.gen(function* () {
		for (const reference of [
			{ kind: 'ref', to: 'parent', optional: true, onDelete: 'setNull' },
			{ kind: 'ref', to: 'parent', optional: true, on_delete: 'setNull' },
			{ kind: 'ref', to: 'parent', optional: true, on_delete: 'set_null', onDelete: 'setNull' }
		]) {
			const declaration = {
				tables: {
					parent: { fields: { name: { kind: 'text' } } },
					child: { fields: { parent: reference } }
				},
				tz: 'UTC',
				currency: null
			};
			expect((yield* Effect.result(decode(declaration)))._tag).toBe('Failure');
		}
	})
);

it.effect('rejects set_null on required references when decoding declarations and snapshots', () =>
	Effect.gen(function* () {
		const declaration = {
			tables: {
				parent: { fields: { name: { kind: 'text' } } },
				child: { fields: { parent: { kind: 'ref', to: 'parent', on_delete: 'set_null' } } }
			},
			tz: 'UTC',
			currency: null
		};
		expect((yield* Effect.flip(decode(declaration))).message).toContain(
			"on_delete 'set_null' needs an optional ref"
		);
		const failure = yield* Effect.flip(read_snapshot(JSON.stringify(declaration)));
		expect(failure.code).toBe('migration_invalid');
		expect(failure.message).toContain("on_delete 'set_null' needs an optional ref");
		const optional = {
			...declaration,
			tables: {
				...declaration.tables,
				child: {
					fields: {
						parent: { kind: 'ref', to: 'parent', optional: true, on_delete: 'set_null' }
					}
				}
			}
		};
		expect(yield* decode(optional)).toEqual(optional);
	})
);
