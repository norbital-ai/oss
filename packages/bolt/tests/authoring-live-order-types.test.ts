import { describe, expect, it } from 'vitest';
import type { CollectionOperations } from '@norbital-ai/std/collection';
import {
	custom,
	defineModel,
	file,
	instant,
	numeric,
	text,
	vector
} from '../src/authoring/index.js';
import type { CollectionRegistryFor, TablesForModels } from '../src/authoring/internals.js';

/**
 * SYNC-400 (RFC/bolt.md B9b): a live read's `orderBy` is typed over the collection's scalar
 * columns, the same set the guest plans with. Ordering a live prefix by a custom-typed, json or
 * vector column used to compile and be refused at `sync.connect`; now it fails where it is written.
 *
 * The negative cases are `@ts-expect-error` lines: `pnpm lint` type-checks this file, so a widening
 * of the vocabulary makes those directives unused and fails the check.
 */
const leavePlans = defineModel({
	code: text().notNull(),
	sequence: numeric(),
	effective_range: custom('instant_range', { precision: 'day' }).notNull(),
	policy: custom('money'),
	tags: text().array(),
	attachment: file(),
	starts_at: instant({ precision: 'day' }),
	embedding: vector({ dimensions: 4 })
});

type Schema = {
	readonly tables: TablesForModels<{ readonly leave_plans: typeof leavePlans }>;
	readonly relations: { readonly leave_plans: Readonly<Record<never, never>> };
};
type Registry = CollectionRegistryFor<Schema>;
declare const plans: CollectionOperations<Registry['leave_plans']>;

type Scalar = Registry['leave_plans']['scalarColumns'];
const includes = <K extends Scalar>(): K | undefined => undefined;
const excludes = <K extends string>(): K extends Scalar ? false : true => true as never;
const scalarSetIsGenerated: [
	ReturnType<
		typeof includes<
			'id' | 'code' | 'sequence' | 'tags' | 'starts_at' | 'created_at' | 'embedded_at'
		>
	>,
	ReturnType<typeof excludes<'effective_range' | 'policy' | 'attachment' | 'embedding'>>
] extends [unknown, true]
	? true
	: false = true;

const admitted = () => {
	plans.findMany({ orderBy: { code: 'asc' } });
	plans.findMany({ orderBy: { sequence: 'desc', id: 'asc' } });
	plans.findMany({ orderBy: { tags: 'asc' } });
	plans.findMany({ orderBy: { starts_at: 'desc' } });
	plans.findMany({ orderBy: { created_at: 'desc' } });
	plans.findFirst({ orderBy: { code: 'asc' } });
	// A page continued with `after` is a one-shot read and keeps the wider vocabulary.
	plans.findMany({ after: 'cursor', orderBy: { effective_range: 'desc' } });
};

const refused = () => {
	// @ts-expect-error a custom-typed range column is json and cannot key a live prefix
	plans.findMany({ orderBy: { effective_range: 'desc' } });
	// @ts-expect-error a custom-typed money column is json and cannot key a live prefix
	plans.findMany({ orderBy: { policy: 'asc' } });
	// @ts-expect-error a file column is json and cannot key a live prefix
	plans.findMany({ orderBy: { attachment: 'asc' } });
	// @ts-expect-error a vector column cannot key a live prefix
	plans.findMany({ orderBy: { embedding: 'asc' } });
	// @ts-expect-error findFirst registers a live prefix too
	plans.findFirst({ orderBy: { effective_range: 'desc' } });
};

describe('live ordering vocabulary', () => {
	it('is the generated scalar column set', () => {
		expect(scalarSetIsGenerated).toBe(true);
		expect(typeof admitted).toBe('function');
		expect(typeof refused).toBe('function');
	});
});
