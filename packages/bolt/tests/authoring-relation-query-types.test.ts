import { describe, expect, it } from 'vitest';
import type { Effect } from 'effect';
import type { Api, SchemaQueryConfig, SchemaQueryRow } from '../src/authoring/contracts-schema.js';

interface TestSchema {
	readonly tables: {
		readonly employees: {
			readonly $inferSelect: {
				readonly id: string;
				readonly name: string;
				readonly active: boolean;
			};
			readonly $inferInsert: { readonly name: string; readonly active: boolean };
		};
		readonly terms: {
			readonly $inferSelect: {
				readonly id: string;
				readonly employee_id: string;
				readonly amount: number;
				readonly effective_on: string;
			};
			readonly $inferInsert: {
				readonly employee_id: string;
				readonly amount: number;
				readonly effective_on: string;
			};
		};
	};
	readonly relations: {
		readonly employees: {
			readonly terms: { readonly target: 'terms'; readonly cardinality: 'many' };
			readonly manager: { readonly target: 'employees'; readonly cardinality: 'one' };
		};
		readonly terms: {
			readonly employee: { readonly target: 'employees'; readonly cardinality: 'one' };
		};
	};
}

declare const employees: Api<TestSchema>['db']['employees'];

const admitted = () =>
	employees.findMany({
		columns: { id: true },
		with: {
			manager: true,
			terms: {
				columns: { amount: true },
				where: { amount: { gt: 0 } },
				with: {
					employee: {
						columns: { name: true },
						with: {
							terms: {
								columns: { id: true },
								where: { effective_on: { lte: '2026-09-08' } }
							}
						}
					}
				}
			}
		}
	});

type Row =
	ReturnType<typeof admitted> extends Effect.Effect<infer Rows, infer _E, infer _R>
		? Rows extends ReadonlyArray<infer One>
			? One
			: never
		: never;

/** These compile-time assertions exercise the public query result, not a hand-written row type. */
const narrowed = (row: Row) => {
	const amount: number = row.terms[0]!.amount;
	const employee: {
		readonly name: string;
		readonly terms: readonly { readonly id: string }[];
	} | null = row.terms[0]!.employee;
	const manager: TestSchema['tables']['employees']['$inferSelect'] | null = row.manager;
	// @ts-expect-error the many relation selects amount, not id
	const absentId: string = row.terms[0]!.id;
	// @ts-expect-error the nested one relation is nullable
	const alwaysPresent: string = row.terms[0]!.employee.name;
	// @ts-expect-error the nested many relation selected id, not amount
	const absentAmount: number = row.terms[0]!.employee?.terms[0]!.amount;
	// @ts-expect-error cardinality one does not produce an array
	const managerList: readonly object[] = row.manager;
	return { amount, employee, manager, absentId, alwaysPresent, absentAmount, managerList };
};

type Disabled = SchemaQueryRow<
	TestSchema,
	'employees',
	{ readonly with: { readonly manager: false } }
>;
const disabledIsAbsent: 'manager' extends keyof Disabled ? false : true = true;

const refused = () => {
	const wrongColumn = {
		with: {
			terms: {
				// @ts-expect-error relation projections use the target collection's columns
				columns: { active: true }
			}
		}
	} satisfies SchemaQueryConfig<TestSchema, 'employees'>;
	const wrongOperand = {
		with: {
			terms: {
				where: {
					// @ts-expect-error a related amount remains numeric in the nested filter
					amount: { eq: 'many' }
				}
			}
		}
	} satisfies SchemaQueryConfig<TestSchema, 'employees'>;
	return { wrongColumn, wrongOperand };
};

describe('ordinary relation query types', () => {
	it('retains target columns, nested relation cardinality and related filters', () => {
		expect(typeof admitted).toBe('function');
		expect(typeof narrowed).toBe('function');
		expect(typeof refused).toBe('function');
		expect(disabledIsAbsent).toBe(true);
	});
});
