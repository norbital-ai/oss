import { describe, expect, it } from 'vitest';
import { isSearchableCollectionField } from '@norbital-ai/std/collection';
import {
	collection,
	defineModel,
	enums,
	phone,
	text,
	workspace
} from '../../src/authoring/index.js';
import { describeModel } from '../../src/authoring/model-introspection.js';
import { extractCollectionCatalog } from '../../src/compiler/model-fields.js';
import { Effect } from 'effect';
import { planWorkspaceMigration } from '../../src/compiler/schema-migrations.js';

/**
 * Free-text search is opt-in: only a column authored `text({ search: true })` is ever matched.
 *
 * `ColumnAuthoring.searchable` used to accept the option and discard it, so nothing downstream knew
 * which columns a query could reach and search matched nothing at all. These fix the opt-in at both
 * ends — the builder that records it, and the catalog the client search UI reads it back from.
 */
describe('searchable field opt-in', () => {
	const opted = defineModel({
		title: text({ search: true }),
		hotline: phone({ search: true }),
		status: enums(['active', 'draft'], { search: true }),
		summary: text(),
		internal_code: text(),
		contact: phone()
	});

	it('records the opt-in on the builder for every text-ish kind', () => {
		const fields = describeModel(opted);
		expect(fields.title?.search).toBe(true);
		expect(fields.hotline?.search).toBe(true);
		expect(fields.status?.search).toBe(true);
	});

	it('leaves an un-opted column with no search flag at all', () => {
		const fields = describeModel(opted);
		// Absent rather than `false`: the catalog omits the key, and a reader testing for the flag
		// must not be able to tell an opted-out column from one that predates the option.
		expect(fields.summary).not.toHaveProperty('search');
		expect(fields.internal_code).not.toHaveProperty('search');
		expect(fields.contact).not.toHaveProperty('search');
	});

	/**
	 * The rule the collection toolbar's search affordance is gated on. It used to appear whenever the
	 * collection had any field at all, which put an inert box on collections where nothing is
	 * searchable — typing into it could only ever return nothing.
	 */
	it('reports no searchable field for a collection that opted none in', () => {
		const fields = describeModel(
			defineModel({ reference: text(), contact: phone(), state: enums(['open', 'paid']) })
		);
		const names = Object.keys(fields);

		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((name) => fields[name]?.search === true)).toHaveLength(0);
		// The control: the gate is the flag, not the field count. Same shape of model, one opt-in.
		expect(
			Object.values(describeModel(opted)).filter((field) => field.search === true)
		).toHaveLength(3);
	});

	/**
	 * The contract the search UI actually depends on, end to end: what a workspace author writes has
	 * to survive the compiler into a catalog field that the predicate every search path shares says
	 * yes to. Asserting the flag alone would miss `kind`, which the predicate weighs just as heavily.
	 */
	it('emits a catalog the shared searchability predicate agrees with', () => {
		const source = `export default defineModel({
	title: text({ search: true }).notNull(),
	summary: text(),
	contact: phone()
});`;
		const catalog = extractCollectionCatalog('products', source, []);

		expect(catalog.fields.length).toBeGreaterThan(0);
		expect(catalog.fields.filter(isSearchableCollectionField).map((field) => field.name)).toEqual([
			'title'
		]);
	});

	it('agrees with that predicate that an opted-out collection is unsearchable', () => {
		const source = `export default defineModel({
	reference: text().notNull(),
	contact: phone()
});`;
		const catalog = extractCollectionCatalog('invoices', source, []);

		expect(catalog.fields.length).toBeGreaterThan(0);
		expect(catalog.fields.filter(isSearchableCollectionField)).toHaveLength(0);
	});

	/**
	 * The two halves of the opt-in, pinned to each other.
	 *
	 * Search only ever runs over the columns that got a trigram index, so the DDL and the search UI have
	 * to agree on the same set. They reach it by different routes — the plan reads
	 * `FieldDefinition.search`, which `describeModelColumns` records off the Drizzle config; the UI runs
	 * `isSearchableCollectionField` over a catalog field, where a `kind` exists to weigh. Nothing but
	 * this assertion stops those routes from drifting, and drift here is silent: an index over a column
	 * search never reads, or a search box over a column with no index behind it.
	 */
	it('indexes exactly the columns the shared predicate calls searchable', async () => {
		const source = [
			'export default defineModel({',
			'\ttitle: text({ search: true }).notNull(),',
			'\thotline: phone({ search: true }),',
			"\tstatus: enums(['active', 'draft'], { search: true }),",
			'\tsummary: text(),',
			'\tcontact: phone()',
			'});'
		].join('\n');
		const catalog = extractCollectionCatalog('products', source, []);
		// Read off the drizzle lineage, which is the only renderer of an authored collection's indexes
		// now. The schema plan used to render them too, from the same `FieldDefinition.search` flag, and
		// two renderings of one table were free to disagree about far more than search.
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: {
					products: defineModel({
						title: text({ search: true }).notNull(),
						hotline: phone({ search: true }),
						status: enums(['active', 'draft'], { search: true }),
						summary: text(),
						contact: phone()
					})
				},
				relations: [],
				previous: undefined
			})
		);
		const indexed = (migration?.statements ?? [])
			.flatMap((statement) => [...statement.matchAll(/"products_(?<column>.+?)_search_trgm_idx"/g)])
			.flatMap((match) => (match.groups?.['column'] === undefined ? [] : [match.groups['column']]))
			.toSorted();
		expect(indexed).toEqual(
			catalog.fields
				.filter(isSearchableCollectionField)
				.map((field) => field.name)
				.toSorted()
		);
		expect(indexed).toEqual(['hotline', 'status', 'title']);
	});
});
