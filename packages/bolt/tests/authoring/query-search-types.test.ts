import { describe, expect, it } from 'vitest';
import { policySql, type Api } from '../../src/authoring/index.js';

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

const admitted = () => {
	articles.findMany({ search: { mode: 'lexical', term: 'ordinary lexical typing' } });
	articles.findMany({ search: { mode: 'semantic', term: 'similar disputes' } });
};

const refused = () => {
	articles.findMany({
		// @ts-expect-error every search mode is explicit; strings are not a compatibility arm
		search: 'ordinary lexical typing'
	});
	articles.findMany({
		// @ts-expect-error root offsets were ignored; continuation is keyset-based
		offset: 10
	});
	articles.findMany({
		where: {
			// @ts-expect-error authored raw SQL was ignored and is not a query vocabulary member
			$sql: 'true'
		}
	});
	const composedOffset = { offset: 10 } as const;
	articles.findMany(composedOffset);
	const composedRawSql = { where: { $sql: 'true' } } as const;
	// @ts-expect-error raw SQL is absent from every authored where branch, including composed input
	articles.findMany(composedRawSql);
	articles.findMany({
		// @ts-expect-error policySql is deliberately absent from the collection query surface
		where: policySql('true')
	});
};

describe('collection query search types', () => {
	it('keeps lexical and semantic modes distinct and removes ignored query members', () => {
		expect(typeof admitted).toBe('function');
		expect(typeof refused).toBe('function');
	});
});
