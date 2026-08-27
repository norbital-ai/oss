import { Schema } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	boolean,
	custom,
	defineModel,
	enums,
	file,
	integer,
	jsonb,
	numeric,
	platformCustomTypes,
	reference,
	schemaFor,
	text,
	uuid,
	type SchemaShape,
	type SchemaShapeConfig,
	type SchemaShapeRow
} from '../../src/authoring/index.js';
import type { TablesForModels } from '../../src/authoring/contracts-schema.js';
import { describeModelColumns } from '../../src/authoring/model-introspection.js';
import {
	registerWorkspaceShape,
	type WorkspaceShape
} from '../../src/authoring/schema-registry.js';
import type { RelationDefinition } from '../../src/authoring/workspace-schema.js';
import { selectedColumnNames } from '../../src/runtime/collections/with-clause.js';

/**
 * That `schema()` is a real Effect `Schema` of exactly the shape its declaration named.
 *
 * The suite has two halves and they are asserting different things. The `@ts-expect-error` lines
 * below fail `tsc -p tests/tsconfig.json` — which `pnpm lint` runs — the moment the returned type
 * stops constraining, and the file stops compiling if it starts refusing a shape it should admit;
 * that is the half nothing at run time can check, because a widened `Schema.Type` decodes exactly as
 * well as an exact one. The `describe` blocks are the other half: what the schema actually accepts.
 *
 * The models are declared here rather than imported, because what is under test is the trip from a
 * `defineModel` declaration to a struct — the same trip `describeModelColumns` makes for the schema
 * plan, so the fields these tests resolve against are the fields the database is created from.
 */

const employments = defineModel({
	code: text().notNull(),
	headcount: integer(),
	active: boolean().notNull()
});

const leaveRequests = defineModel({
	employment_id: uuid().notNull(),
	reason: text()
});

const timeEntries = defineModel({
	employment_id: uuid().notNull(),
	work_date: text().notNull(),
	status: enums(['DRAFT', 'APPROVED']).notNull(),
	hours: numeric(),
	pay: custom('money').notNull(),
	attachment: file(),
	worked_intervals: jsonb(),
	source: reference({ EMPLOYMENT: 'employments', LEAVE_REQUEST: 'leave_requests' })
});

const models = {
	employments,
	leave_requests: leaveRequests,
	time_entries: timeEntries
} as const;

type TestSchema = {
	readonly tables: TablesForModels<typeof models>;
	readonly relations: Readonly<Record<string, never>>;
};

const relations: ReadonlyArray<RelationDefinition> = [
	{
		name: 'time_entry_employment',
		source: 'time_entries',
		target: 'employments',
		cardinality: 'one',
		from: { collection: 'time_entries', column: 'employment_id' },
		to: { collection: 'employments', column: 'id' }
	},
	{
		name: 'employment_time_entries',
		source: 'employments',
		target: 'time_entries',
		cardinality: 'many',
		from: { collection: 'time_entries', column: 'employment_id' },
		to: { collection: 'employments', column: 'id' }
	}
];

const shape: WorkspaceShape = {
	collections: Object.entries(models).map(([name, model]) => ({
		name,
		fields: describeModelColumns(model.columns),
		history: true
	})),
	relations,
	customTypes: platformCustomTypes
};

const register = (): void => {
	registerWorkspaceShape(shape);
};

const schema: SchemaShape<TestSchema> = schemaFor<TestSchema>();
const decode = <S extends Schema.Codec<unknown>>(declared: S, value: unknown): unknown =>
	Schema.decodeUnknownSync(declared)(value);

const systemColumns = {
	id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
	created_at: '2026-08-28T00:00:00Z',
	updated_at: null,
	sys_period: '["2026-08-28 00:00:00+00",)',
	row_version: 1,
	approval_id: null
};

// ---------------------------------------------------------------------------
// Compile-time half.
// ---------------------------------------------------------------------------

const declaration = {
	columns: { employment_id: true, work_date: true }
} as const satisfies SchemaShapeConfig<TestSchema, 'time_entries'>;

const input = schema('time_entries', declaration);
type Input = Schema.Schema.Type<typeof input>;

/** The declared columns, at their declared types — not a widened row and not `unknown`. */
const exact: Input = { employment_id: 'e', work_date: '2026-08-28' };

/** The negative control: a column outside the declaration is not part of the shape. */
// @ts-expect-error — `status` was not declared by this shape
const outsideTheShape: Input = { employment_id: 'e', work_date: '2026-08-28', status: 'DRAFT' };

/** Inclusive selection keeps every column it named, so none of them is optional. */
// @ts-expect-error — `work_date` was declared by this shape and must be present
const incomplete: Input = { employment_id: 'e' };

/** `where` chooses which records answer, which is not a question a shape asks. */
// prettier-ignore
// @ts-expect-error — `where` is not part of a shape declaration
const narrowsRows = schema('time_entries', { where: { work_date: { eq: '2026-08-28' } } });

/** Nor are the other three members of a read that pick rows rather than describe one. */
// prettier-ignore
// @ts-expect-error — `orderBy`, `limit` and `offset` are not part of a shape declaration
const ordersRows = schema('time_entries', { orderBy: { work_date: 'asc' }, limit: 10, offset: 0 });

/** A column the collection does not declare is not selectable. */
// @ts-expect-error — `salary` is not a column of time_entries
const unknownColumn = schema('time_entries', { columns: { salary: true } });

/** A collection the workspace does not declare cannot be named. */
// @ts-expect-error — `payroll_runs` is not a collection of this workspace
const unknownCollection = schema('payroll_runs', { columns: { id: true } });

describe('schema() as a type', () => {
	it('admits the declarations above and rejects the ones marked, at compile time', () => {
		expect([
			exact,
			outsideTheShape,
			incomplete,
			narrowsRows,
			ordersRows,
			unknownColumn,
			unknownCollection
		]).toHaveLength(7);
		expectTypeOf<Input['employment_id']>().toEqualTypeOf<string>();
		// The schema's type *is* the read's type for the same declaration — one type, not two.
		expectTypeOf<Input>().toEqualTypeOf<
			SchemaShapeRow<TestSchema, 'time_entries', typeof declaration>
		>();
	});
});

// ---------------------------------------------------------------------------
// Run-time half.
// ---------------------------------------------------------------------------

describe('schema() as a schema', () => {
	it('resolves lazily, so a module-init declaration does not depend on import order', () => {
		// Declared while the registry holds no collection at all — which is the state a `+hooks.ts`
		// evaluating `export const input = schema(…)` before the workspace module may be in.
		registerWorkspaceShape({ collections: [], relations: [] });
		const declared = schema('employments', { columns: { code: true } });
		register();
		expect(decode(declared, { code: 'A', headcount: 3 })).toEqual({ code: 'A' });
	});

	it('names a collection nobody declared only when the shape is used, and then says so', () => {
		register();
		const declared = schemaFor<{
			readonly tables: Readonly<Record<string, never>>;
			readonly relations: Readonly<Record<string, never>>;
		}>();
		const missing = declared('nowhere');
		expect(() => decode(missing, {})).toThrow(/does not declare/u);
	});

	it('carries the platform columns a collection never declares for itself', () => {
		register();
		const declared = schema('employments');
		const row = { ...systemColumns, code: 'A', headcount: 3, active: true };
		expect(Object.keys(decode(declared, row) as object).toSorted()).toEqual(
			Object.keys(row).toSorted()
		);
	});

	it('reads `columns` inclusively the moment any member is true', () => {
		register();
		const declared = schema('employments', { columns: { code: true, headcount: false } });
		expect(decode(declared, { ...systemColumns, code: 'A', headcount: 3, active: true })).toEqual({
			code: 'A'
		});
	});

	it('reads `columns` exclusively when every member is false', () => {
		register();
		const declared = schema('employments', { columns: { headcount: false, active: false } });
		const kept = Object.keys(
			decode(declared, { ...systemColumns, code: 'A', headcount: 3, active: true }) as object
		);
		expect(kept).toContain('code');
		expect(kept).toContain('id');
		expect(kept).not.toContain('headcount');
		expect(kept).not.toContain('active');
	});

	it('tells numeric and integer apart, which one scalar kind cannot', () => {
		register();
		const declared = schema('time_entries', { columns: { hours: true } });
		const counted = schema('employments', { columns: { headcount: true } });
		expect(decode(declared, { hours: 1.5 })).toEqual({ hours: 1.5 });
		expect(() => decode(counted, { headcount: 1.5 })).toThrow();
		expect(decode(counted, { headcount: 3 })).toEqual({ headcount: 3 });
	});

	it('checks a uuid, an enum and a file by what the column declares', () => {
		register();
		const declared = schema('time_entries', {
			columns: { employment_id: true, status: true, attachment: true }
		});
		const attachment = {
			storage_key: 'k',
			file_name: 'n.pdf',
			file_size: 12,
			mime_type: 'application/pdf'
		};
		expect(
			decode(declared, {
				employment_id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
				status: 'APPROVED',
				attachment
			})
		).toEqual({
			employment_id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
			status: 'APPROVED',
			attachment
		});
		expect(() =>
			decode(declared, { employment_id: 'not-a-uuid', status: 'APPROVED', attachment })
		).toThrow();
		expect(() =>
			decode(declared, {
				employment_id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
				status: 'REJECTED',
				attachment
			})
		).toThrow();
		expect(() =>
			decode(declared, {
				employment_id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
				status: 'APPROVED',
				attachment: { storage_key: 'k' }
			})
		).toThrow();
	});

	/**
	 * The point of this one is that nothing here validates money. `describeInvalidCustomValue` does,
	 * from the same registry the command boundary reads, so a shape and a write cannot disagree about
	 * what a `custom('money')` is.
	 */
	it('checks a custom column through the datatype registry the write path already uses', () => {
		register();
		const declared = schema('time_entries', { columns: { pay: true } });
		expect(decode(declared, { pay: { value: 10, currency: 'SGD' } })).toEqual({
			pay: { value: 10, currency: 'SGD' }
		});
		expect(() => decode(declared, { pay: { value: 10, currency: 'dollars' } })).toThrow(
			/not a valid money/u
		);
	});

	it('carries a polymorphic reference as the discriminated handle it is', () => {
		register();
		const declared = schema('time_entries', { columns: { source: true } });
		expect(
			decode(declared, {
				source: { kind: 'EMPLOYMENT', id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1' }
			})
		).toEqual({ source: { kind: 'EMPLOYMENT', id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1' } });
		expect(() =>
			decode(declared, { source: { kind: 'PAYSLIP', id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1' } })
		).toThrow();
	});

	it('hydrates a reference named under `with` into the record it points at', () => {
		register();
		const declared = schema('time_entries', {
			columns: { id: true },
			with: { source: { EMPLOYMENT: { columns: { code: true } } } }
		});
		expect(
			decode(declared, {
				id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
				source: {
					kind: 'EMPLOYMENT',
					id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d2',
					record: { code: 'A' }
				}
			})
		).toEqual({
			id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
			source: {
				kind: 'EMPLOYMENT',
				id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d2',
				record: { code: 'A' }
			}
		});
	});

	it('makes a many relation an array and a one relation nullable', () => {
		register();
		const many = schema('employments', {
			columns: { code: true },
			with: { employment_time_entries: { columns: { work_date: true } } }
		});
		const one = schema('time_entries', {
			columns: { work_date: true },
			with: { time_entry_employment: { columns: { code: true } } }
		});
		expect(
			decode(many, { code: 'A', employment_time_entries: [{ work_date: '2026-08-28' }] })
		).toEqual({ code: 'A', employment_time_entries: [{ work_date: '2026-08-28' }] });
		expect(() =>
			decode(many, { code: 'A', employment_time_entries: { work_date: 'x' } })
		).toThrow();
		expect(decode(one, { work_date: '2026-08-28', time_entry_employment: null })).toEqual({
			work_date: '2026-08-28',
			time_entry_employment: null
		});
		expect(() => decode(one, { work_date: '2026-08-28', time_entry_employment: [] })).toThrow();
	});

	it('refuses a `with` entry that names neither a reference column nor a declared relation', () => {
		register();
		const declared = schema('time_entries', {
			columns: { work_date: true },
			with: { invented: true }
		});
		expect(() => decode(declared, { work_date: '2026-08-28' })).toThrow(/neither a reference/u);
	});

	/**
	 * `with-clause.ts` owns the inclusive/exclusive rule; `selectedColumnNames` is the one statement of
	 * it, and both a read and a shape call it. This drives the rule with the same clause the shape is
	 * declared with and asserts they agree — that narrowing a related record and building a nested
	 * struct route through that one rule rather than one of them growing a reading of its own.
	 */
	it('narrows a nested record to the same columns a read keeps', () => {
		register();
		expect(selectedColumnNames(['id', 'code', 'active'], { code: true })).toEqual(['code']);
		expect(selectedColumnNames(['id', 'code', 'active'], { active: false })).toEqual(['id', 'code']);

		const declared = schema('time_entries', {
			columns: { work_date: true },
			with: { time_entry_employment: { columns: { code: true } } }
		});
		expect(
			decode(declared, { work_date: '2026-08-28', time_entry_employment: { code: 'A' } })
		).toEqual({ work_date: '2026-08-28', time_entry_employment: { code: 'A' } });
		expect(() =>
			decode(declared, { work_date: '2026-08-28', time_entry_employment: { active: true } })
		).toThrow();
	});

	it('composes, because what comes back is an ordinary schema', () => {
		register();
		const declared = schema('employments', { columns: { code: true } });
		const extended = Schema.Struct({ record: declared, note: Schema.String });
		expect(decode(extended, { record: { code: 'A' }, note: 'hello' })).toEqual({
			record: { code: 'A' },
			note: 'hello'
		});
		const either = Schema.Union([declared, Schema.Struct({ absent: Schema.Boolean })]);
		expect(decode(either, { absent: true })).toEqual({ absent: true });
	});
});
