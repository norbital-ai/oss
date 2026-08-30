import { describe, expect, it } from 'vitest';
import { policySql, type PolicyDefinition } from '../../src/authoring/index.js';
import { describePolicy } from '../../src/authoring/policy-introspection.js';

interface TestSchema {
	readonly tables: {
		readonly articles: {
			readonly $inferSelect: { readonly id: string; readonly owner_id: string };
			readonly $inferInsert: { readonly owner_id: string };
		};
	};
	readonly relations: { readonly articles: Readonly<Record<string, never>> };
}

const declaration = {
	description: 'Reads only rows selected by trusted policy SQL.',
	grants: {
		articles: {
			read: { where: policySql('"owner_id" = ${requestor.id}') },
			history: { where: policySql('"owner_id" = ${requestor.id}') }
		}
	}
} satisfies PolicyDefinition<TestSchema>;

const refusedWriteWhere = () => {
	const invalid = {
		description: 'A write cannot acquire a SQL where escape.',
		grants: {
			articles: {
				mutate: {
					new: {
						// @ts-expect-error policySql is limited to read and history grants
						where: policySql('true')
					}
				}
			}
		}
	} satisfies PolicyDefinition<TestSchema>;
	return invalid;
};

describe('policySql', () => {
	it('authors a frozen discriminated JSON predicate and survives policy introspection', () => {
		const predicate = policySql('"owner_id" = ${requestor.id}');
		expect(predicate).toEqual({
			kind: 'policy-sql',
			statement: '"owner_id" = ${requestor.id}'
		});
		expect(Object.isFrozen(predicate)).toBe(true);
		expect(JSON.parse(JSON.stringify(predicate))).toEqual(predicate);

		const described = describePolicy('article-owner', declaration);
		expect(described.grants?.map(({ where }) => where)).toEqual([predicate, predicate]);
	});

	it('refuses empty statements, legacy syntax, and malformed serialized predicates', () => {
		expect(() => policySql('   ')).toThrow(/non-empty SQL statement/u);
		expect(() =>
			describePolicy('legacy', {
				description: 'Legacy raw predicate.',
				grants: { articles: { read: { where: { $sql: 'true' } } } }
			})
		).toThrow(/removed \$sql policy syntax/u);
		expect(() =>
			describePolicy('empty', {
				description: 'Empty trusted predicate.',
				grants: {
					articles: { read: { where: { kind: 'policy-sql', statement: '  ' } } }
				}
			})
		).toThrow(/non-empty string/u);
		expect(() =>
			describePolicy('extra', {
				description: 'Predicate with an unsupported key.',
				grants: {
					articles: {
						read: {
							where: { kind: 'policy-sql', statement: 'true', parameters: [] }
						}
					}
				}
			})
		).toThrow(/unsupported parameters key/u);
	});

	it('keeps the write-only type refusal in the compilation corpus', () => {
		expect(typeof refusedWriteWhere).toBe('function');
	});

	it('flattens the two authored mutation branches to runtime actions', () => {
		const described = describePolicy('article-mutator', {
			description: 'New and existing rows have independent authority.',
			grants: {
				articles: { mutate: { new: { fields: ['owner_id'] }, existing: {} } }
			}
		});
		expect(described.grants).toEqual([
			expect.objectContaining({ collection: 'articles', action: 'create', fields: ['owner_id'] }),
			expect.objectContaining({ collection: 'articles', action: 'update' })
		]);
		const existingOnly = describePolicy('article-editor', {
			description: 'Existing rows may change, but no new row may be added.',
			grants: { articles: { mutate: { existing: {} } } }
		});
		expect(existingOnly.actions).toEqual(['update']);
	});

	it('hard-refuses the removed create and update collection grant keys', () => {
		for (const removed of ['create', 'update']) {
			expect(() =>
				describePolicy('removed-write-key', {
					description: 'Removed policy authoring key.',
					grants: { articles: { [removed]: {} } }
				})
			).toThrow(new RegExp(`unsupported ${removed} key`, 'u'));
			expect(() =>
				describePolicy('removed-mutation-branch', {
					description: 'Removed mutation branch.',
					grants: { articles: { mutate: { [removed]: {} } } }
				})
			).toThrow(new RegExp(`unsupported ${removed} key`, 'u'));
		}
	});
});
