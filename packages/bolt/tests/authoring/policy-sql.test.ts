import { describe, expect, it } from 'vitest';
import * as authoring from '../../src/authoring/index.js';
import { describePolicy } from '../../src/authoring/policy-introspection.js';

describe('closed structured policy language', () => {
	it('removes the SQL authoring helper and refuses serialized SQL tokens', () => {
		expect('policySql' in authoring).toBe(false);
		const serializedSqlToken = { kind: 'policy-sql', statement: '"owner_id" = true' };
		for (const action of ['read', 'history']) {
			expect(() =>
				describePolicy('article-owner', {
					description: 'Serialized SQL cannot become a row policy.',
					grants: { articles: { [action]: { where: serializedSqlToken } } }
				})
			).toThrow(/administrative one-shot SQL/u);
		}
	});

	it('refuses every legacy policy SQL spelling', () => {
		expect(() =>
			describePolicy('legacy', {
				description: 'Legacy raw predicate.',
				grants: { articles: { read: { where: { $sql: 'true' } } } }
			})
		).toThrow(/closed structured predicate language/u);
		expect(() =>
			describePolicy('empty-serialized', {
				description: 'Empty serialized administrative token.',
				grants: {
					articles: {
						read: { where: { kind: 'policy-sql', statement: '   ' } }
					}
				}
			})
		).toThrow(/administrative one-shot SQL/u);
	});

	it('accepts structured read/history predicates and rejects authored dependencies', () => {
		const described = describePolicy('article-owner', {
			description: 'Reads only records owned by the subject.',
			grants: {
				articles: {
					read: { where: { owner_id: { eq: { $subject: 'id' } } } },
					history: { where: { owner_id: { eq: { $subject: 'id' } } } }
				}
			}
		});
		expect(described.grants?.map(({ where }) => where)).toEqual([
			{ owner_id: { eq: { $subject: 'id' } } },
			{ owner_id: { eq: { $subject: 'id' } } }
		]);
		const scoped = describePolicy('team-subtree', {
			description: 'Reads records owned by users in the subject team subtree.',
			grants: { articles: { read: { where: { owner_id: { teamScopeUsers: true } } } } }
		});
		expect(scoped.grants?.[0]?.where).toEqual({ owner_id: { teamScopeUsers: true } });
		expect(() =>
			describePolicy('manual-dependency', {
				description: 'Dependencies must be compiler-derived.',
				grants: {
					articles: { read: { where: { owner_id: 'owner' }, dependencies: ['users'] } }
				}
			})
		).toThrow(/unsupported dependencies key/u);
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
