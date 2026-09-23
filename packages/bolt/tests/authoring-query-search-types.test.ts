import { describe, expect, it } from 'vitest';
import type { Api, SchemaQueryConfig } from '../src/authoring/index.js';

interface TestSchema {
	readonly tables: {
		readonly articles: {
			readonly $inferSelect: { readonly id: string; readonly title: string };
			readonly $inferInsert: { readonly title: string };
		};
	};
	readonly relations: { readonly articles: Readonly<Record<string, never>> };
}

declare const articles: Api<TestSchema>['db']['articles'];

const searchIsOneString: NonNullable<
	SchemaQueryConfig<TestSchema, 'articles'>['search']
> extends string
	? true
	: false = true;

const admitted = () => {
	articles.findMany({ search: 'ordinary lexical typing' });
	articles.findMany({ search: '/semantic similar disputes' });
	// @ts-expect-error the structured search modes are retired: one string, one grammar
	articles.findMany({ search: { mode: 'lexical', term: 'x' } });
};

const refused = () => {
	const rootOffset = {
		// @ts-expect-error root offsets were ignored; continuation is keyset-based
		offset: 10
	} satisfies SchemaQueryConfig<TestSchema, 'articles'>;
	const rawSql = {
		where: {
			// @ts-expect-error authored raw SQL was ignored and is not a query vocabulary member
			$sql: 'true'
		}
	} satisfies SchemaQueryConfig<TestSchema, 'articles'>;
	const policyOnlyMembership = {
		where: {
			id: {
				// @ts-expect-error descendant-user membership is policy-only
				teamScopeUsers: true
			}
		}
	} satisfies SchemaQueryConfig<TestSchema, 'articles'>;
	void rootOffset;
	void rawSql;
	void policyOnlyMembership;
};

describe('collection query search types', () => {
	it('takes search as one string and removes ignored query members', () => {
		expect(searchIsOneString).toBe(true);
		expect(typeof admitted).toBe('function');
		expect(typeof refused).toBe('function');
	});
});
