import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineModel, reference, text, vector } from '../../src/authoring/index.js';
import type {
	SchemaQueryConfig,
	SchemaQueryRow,
	TablesForModels
} from '../../src/authoring/contracts-schema.js';
import { describeModelColumns } from '../../src/authoring/model-introspection.js';
import {
	referenceDatabaseIdentifier,
	referenceStorageColumn
} from '../../src/authoring/models-schema.js';
import {
	decodeReferenceRow,
	encodeReferenceValues,
	referenceValueProblem
} from '../../src/runtime/collections/references.js';

const payslipSources = defineModel({
	period: text().notNull(),
	source: reference({
		TIME_ENTRY: 'time_entries',
		LEAVE_REQUEST: 'leave_requests'
	})
		.notNull()
		.unique()
});

type Source = TablesForModels<{
	readonly payslip_sources: typeof payslipSources;
}>['payslip_sources']['$inferSelect']['source'];

const models = {
	time_entries: defineModel({ work_date: text().notNull() }),
	leave_requests: defineModel({ from_date: text().notNull() }),
	payslip_sources: payslipSources
} as const;
type Tables = TablesForModels<typeof models>;
type TestSchema = {
	readonly tables: Tables;
	readonly relations: Readonly<Record<string, never>>;
};

describe('polymorphic reference authoring', () => {
	it('infers one exact discriminated handle instead of sibling relation properties', () => {
		expectTypeOf<Source>().toEqualTypeOf<
			| Readonly<{ readonly kind: 'TIME_ENTRY'; readonly id: string }>
			| Readonly<{ readonly kind: 'LEAVE_REQUEST'; readonly id: string }>
		>();
	});

	it('types reference filters against the same exact handle and kind union', () => {
		const config = {
			where: {
				source: {
					eq: {
						kind: 'TIME_ENTRY',
						id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1'
					},
					kind: { ne: 'LEAVE_REQUEST' }
				}
			}
		} as const satisfies SchemaQueryConfig<TestSchema, 'payslip_sources'>;
		expect(config.where.source.eq.kind).toBe('TIME_ENTRY');
	});

	it('replaces that same property with an exact hydrated union when requested', () => {
		const config = {
			with: {
				source: {
					TIME_ENTRY: { columns: { work_date: true } },
					LEAVE_REQUEST: { columns: { from_date: true } }
				}
			}
		} as const satisfies SchemaQueryConfig<TestSchema, 'payslip_sources'>;
		type Hydrated = SchemaQueryRow<TestSchema, 'payslip_sources', typeof config>['source'];
		type Expected =
			| Readonly<{
					readonly kind: 'TIME_ENTRY';
					readonly id: string;
					readonly record: Pick<Tables['time_entries']['$inferSelect'], 'work_date'> | null;
			  }>
			| Readonly<{
					readonly kind: 'LEAVE_REQUEST';
					readonly id: string;
					readonly record: Pick<Tables['leave_requests']['$inferSelect'], 'from_date'> | null;
			  }>;
		expectTypeOf<Hydrated>().toMatchTypeOf<Expected>();
		expectTypeOf<Expected>().toMatchTypeOf<Hydrated>();
	});

	it('describes the hidden exclusive-arc storage without exposing it as logical fields', () => {
		expect(describeModelColumns(payslipSources.columns).source).toMatchObject({
			type: 'reference',
			required: true,
			unique: true,
			reference: {
				targets: [
					{
						tag: 'TIME_ENTRY',
						collection: 'time_entries',
						storageColumn: 'source__time_entry_id'
					},
					{
						tag: 'LEAVE_REQUEST',
						collection: 'leave_requests',
						storageColumn: 'source__leave_request_id'
					}
				]
			}
		});
	});

	it('refuses degenerate target sets and shortens long physical identifiers deterministically', () => {
		expect(() => reference({ ONLY: 'time_entries' })).toThrow('at least two targets');
		expect(() => reference({ TIME_ENTRY: 'time_entries', ALIAS: 'time_entries' })).toThrow(
			'same target collection'
		);
		const storage = referenceStorageColumn(
			'exceptionally_long_polymorphic_business_reference_field',
			'EXCEPTIONALLY_LONG_TARGET_KIND'
		);
		expect(new TextEncoder().encode(storage)).toHaveLength(63);
		expect(storage).toBe(
			referenceStorageColumn(
				'exceptionally_long_polymorphic_business_reference_field',
				'EXCEPTIONALLY_LONG_TARGET_KIND'
			)
		);
		const constraint = referenceDatabaseIdentifier(
			'exceptionally_long_collection_name_for_reference_constraints',
			'exceptionally_long_reference_field',
			'exceptionally_long_target_kind',
			'fk'
		);
		expect(new TextEncoder().encode(constraint)).toHaveLength(63);
		expect(constraint).toBe(
			referenceDatabaseIdentifier(
				'exceptionally_long_collection_name_for_reference_constraints',
				'exceptionally_long_reference_field',
				'exceptionally_long_target_kind',
				'fk'
			)
		);
	});

	it('round-trips the public handle and clears every unselected arm on writes', () => {
		const fields = describeModelColumns(payslipSources.columns);
		const encoded = encodeReferenceValues(
			{
				period: '2026-08',
				source: {
					kind: 'TIME_ENTRY',
					id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1'
				}
			},
			fields
		);
		expect(encoded).toEqual({
			period: '2026-08',
			source__time_entry_id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
			source__leave_request_id: null
		});
		expect(decodeReferenceRow(encoded, fields)).toEqual({
			period: '2026-08',
			source: {
				kind: 'TIME_ENTRY',
				id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1'
			}
		});
		expect(
			referenceValueProblem(
				{ source: { kind: 'UNKNOWN', id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1' } },
				fields
			)
		).toContain('unknown kind');
		expect(() => decodeReferenceRow({ period: '2026-08' }, fields)).toThrow(
			'required reference "source" has no populated target arm'
		);
	});

	it('decodes authored and platform pgvector text into finite number arrays', () => {
		const fields = describeModelColumns(
			defineModel({ perceptual_embedding: vector({ dimensions: 3 }).notNull() }).columns
		);
		expect(
			decodeReferenceRow(
				{
					perceptual_embedding: '[0.25,-1,2.5]',
					record_embedding: '[3,4,5]'
				},
				fields
			)
		).toEqual({
			perceptual_embedding: [0.25, -1, 2.5],
			record_embedding: [3, 4, 5]
		});
		expect(() =>
			decodeReferenceRow({ perceptual_embedding: '[0,"bad",2]' }, fields)
		).toThrow('Vector integrity violation');
	});
});
