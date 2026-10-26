import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { build, readSnapshot, schema, SchemaSpec, table } from '../src/index.ts';

const decode = Schema.decodeUnknownEffect(SchemaSpec);

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
				const failure = yield* Effect.flip(readSnapshot(JSON.stringify(declaration)));
				expect(failure.code).toBe('migrationInvalid');
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
	'accepts state edit fields, references, inverse and through relations without forbidding nested states',
	() =>
		Effect.gen(function* () {
			const declaration = {
				tables: {
					entry: {
						managedDeletes: true,
						fields: {
							name: { kind: 'text' },
							owner: { kind: 'ref', to: 'person', optional: true },
							status: {
								kind: 'state',
								optional: true,
								initial: 'open',
								states: {
									open: { to: ['locked'], edit: 'all' },
									locked: { to: ['open'], edit: ['name', 'owner', 'status', 'children', 'tags'] },
									archived: { edit: 'none' }
								}
							},
							payload: {
								kind: 'object',
								fields: {
									status: { kind: 'state', initial: 'open', states: { open: {} } }
								}
							}
						},
						through: { tags: { table: 'entry_tag', from: 'entry', to: 'tag' } }
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
			expect(yield* readSnapshot(JSON.stringify(declaration))).toEqual(declaration);
		})
);

it.effect('rejects state edits of missing, computed, derived and audit-only fields', () =>
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
							status: { kind: 'state', initial: 'open', states: { open: { edit: [field] } } }
						},
						computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } }
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

it.effect('rejects setNull on required references when decoding declarations and snapshots', () =>
	Effect.gen(function* () {
		const declaration = {
			tables: {
				parent: { fields: { name: { kind: 'text' } } },
				child: { fields: { parent: { kind: 'ref', to: 'parent', onDelete: 'setNull' } } }
			},
			tz: 'UTC',
			currency: null
		};
		expect((yield* Effect.flip(decode(declaration))).message).toContain(
			"onDelete 'setNull' needs an optional ref"
		);
		const failure = yield* Effect.flip(readSnapshot(JSON.stringify(declaration)));
		expect(failure.code).toBe('migrationInvalid');
		expect(failure.message).toContain("onDelete 'setNull' needs an optional ref");
		const optional = {
			...declaration,
			tables: {
				...declaration.tables,
				child: {
					fields: {
						parent: { kind: 'ref', to: 'parent', optional: true, onDelete: 'setNull' }
					}
				}
			}
		};
		expect(yield* decode(optional)).toEqual(optional);
	})
);
