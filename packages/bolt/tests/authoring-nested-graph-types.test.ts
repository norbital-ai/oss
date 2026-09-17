import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineCollection } from '../src/authoring/collection-schema.js';
import type {
	CollectionInputOf,
	CollectionPatchPayload,
	CollectionPayload
} from '../src/authoring/collection-schema.js';
import type { CollectionWriteApi } from '../src/authoring/contracts-schema.js';
import { defineModel, numeric, text } from '../src/authoring/models-schema.js';
import { refuse } from '../src/authoring/refusal.js';

/**
 * That a nested write is checked at compile time, not discovered at run time.
 *
 * These assertions are the test. Every `@ts-expect-error` below fails `tsc -p tests/tsconfig.json`
 * — which `pnpm lint` runs — the moment the type stops rejecting the shape it names, and the file
 * stops compiling at all if the type starts rejecting a shape it should admit. The runtime
 * assertion at the bottom exists only so the suite has something to run.
 *
 * The schema is written by hand rather than generated, because what is under test is the type the
 * compiler emits *into*: `tables` and `relations` keyed by collection then by declared relation
 * name. `renderRelationTypes` in `compiler/workspace-build.ts` produces exactly this shape.
 */
interface TestSchema {
	readonly tables: {
		readonly payroll_runs: {
			$inferSelect: { id: string; company_id: string; period: string };
			$inferInsert: { company_id: string; period: string; configuration_hash?: string };
		};
		readonly payslips: {
			$inferSelect: { id: string; payroll_run_id: string; gross: number };
			$inferInsert: { payroll_run_id: string; employment_id: string; gross: number };
		};
		readonly payslip_lines: {
			$inferSelect: { id: string; payslip_id: string; amount: number };
			$inferInsert: { payslip_id: string; amount: number };
		};
		readonly companies: {
			$inferSelect: { id: string; name: string };
			$inferInsert: { name: string };
		};
	};
	readonly relations: {
		readonly payroll_runs: {
			readonly payslip_payroll_run: {
				readonly target: 'payslips';
				readonly cardinality: 'many';
				readonly column: 'payroll_run_id';
				readonly parentColumn: 'id';
				readonly cascade: false;
			};
			// A `one` relation points at a parent that must already exist. Not expandable.
			readonly payroll_run_company: {
				readonly target: 'companies';
				readonly cardinality: 'one';
				readonly column: 'company_id';
				readonly parentColumn: 'id';
				readonly cascade: false;
			};
		};
		readonly payslips: {
			readonly payslip_line_payslip: {
				readonly target: 'payslip_lines';
				readonly cardinality: 'many';
				readonly column: 'payslip_id';
				readonly parentColumn: 'id';
				readonly cascade: false;
			};
		};
	};
}

type RunPayload = CollectionPayload<TestSchema, 'payroll_runs'>;
type RunPatch = CollectionPatchPayload<TestSchema, 'payroll_runs'>;

/** Columns alone: no relation action is required of anyone. */
const flat: RunPayload = { company_id: 'c', period: '2026-08' };

/** One level, keyed by the declared relation name, holding an explicit action (RFC §4.3). */
const nested: RunPayload = {
	company_id: 'c',
	period: '2026-08',
	payslip_payroll_run: { create: [{ employment_id: 'e', gross: 100 }] }
};

/** Three levels. Depth is the author's choice and each level is checked. */
const deep: RunPayload = {
	company_id: 'c',
	period: '2026-08',
	payslip_payroll_run: {
		create: [{ employment_id: 'e', gross: 100, payslip_line_payslip: { create: [{ amount: 25 }] } }]
	}
};

/** Every action of the grammar: update by id, upsert by values, link/unlink/delete by id. */
const everyAction: RunPatch = {
	period: '2026-09',
	payslip_payroll_run: {
		update: [{ id: 'p1', set: { gross: 1 } }],
		upsert: [{ values: { employment_id: 'e', gross: 2 }, onConflictDoUpdate: { gross: 2 } }],
		link: [{ id: 'p2' }],
		unlink: [{ id: 'p3', set: { gross: 0 } }],
		delete: [{ id: 'p4' }]
	}
};

/** A misspelled relation name is not a free-form key. */
// @ts-expect-error — `payslip_payroll_runs` is not a declared relation of payroll_runs
const typo: RunPayload = { company_id: 'c', period: '2026-08', payslip_payroll_runs: {} };

/** A relation holds actions, never a bare list of rows: nothing is inferred from an array. */
// prettier-ignore
// @ts-expect-error — a relation value names its actions
const bareRows: RunPayload = { company_id: 'c', period: '2026-08', payslip_payroll_run: [{ employment_id: 'e', gross: 1 }] };

/** A child is typed as its own collection's insert, not as anything. */
// prettier-ignore
// @ts-expect-error — `gross` is a number on payslips
const wrongChildColumn: RunPayload = { company_id: 'c', period: '2026-08', payslip_payroll_run: { create: [{ employment_id: 'e', gross: 'lots' }] } };

/** The runtime fills the child's foreign key from the parent. The author may not claim it. */
// prettier-ignore
// @ts-expect-error — payroll_run_id is omitted from the child create
const writesTheForeignKey: RunPayload = { company_id: 'c', period: '2026-08', payslip_payroll_run: { create: [{ payroll_run_id: 'r', employment_id: 'e', gross: 100 }] } };

/** A `one` relation is not a nested write: its target has to exist already. */
// prettier-ignore
// @ts-expect-error — payroll_run_company is cardinality 'one'
const expandsAOneRelation: RunPayload = { company_id: 'c', period: '2026-08', payroll_run_company: { create: [{ name: 'Acme' }] } };

/** An update names its row; a patch without an id is not an update. */
// prettier-ignore
// @ts-expect-error — update entries carry { id, set }
const updateWithoutId: RunPatch = { payslip_payroll_run: { update: [{ set: { gross: 1 } }] } };

/** The runtime never accepts a system column in a payload. */
// @ts-expect-error — `id` is runtime-owned
const claimsAnId: RunPayload = { id: 'r', company_id: 'c', period: '2026-08' };

/** --- the declared input, typed from the model's own builders (RFC §4.2) --- */

const runs = defineModel({
	company_id: text().notNull(),
	period: text().notNull(),
	note: text(),
	total: numeric()
});

type CreateOnly = {
	readonly input: {
		readonly columns: { readonly company_id: true; readonly period: true; readonly note: true };
	};
};
type CreateInput = CollectionInputOf<typeof runs, CreateOnly, 'create'>;
type UpdateInput = CollectionInputOf<typeof runs, CreateOnly, 'update'>;

/** Create requires the selected non-null undefaulted columns and takes the nullable ones optionally. */
const createInput: CreateInput = { company_id: 'c', period: '2026-08' };
const createInputWithNote: CreateInput = { company_id: 'c', period: '2026-08', note: 'n' };
/** Update is a patch: every selected column is optional. */
const updateInput: UpdateInput = { note: 'n' };

// @ts-expect-error — period is selected, non-null and undefaulted, so a create must carry it
const createMissingRequired: CreateInput = { company_id: 'c' };

// @ts-expect-error — total is a model column but not in the selection
const createOutsideSelection: CreateInput = { company_id: 'c', period: '2026-08', total: 1 };

// @ts-expect-error — the selection's column keeps the model's type
const createWrongType: UpdateInput = { note: 1 };

/** --- the declaration and the write surface it exposes --- */

const runsCollection = defineCollection({
	model: runs,
	create: { input: { columns: { company_id: true, period: true, note: true } } },
	delete: {},
	transform: (inputs) =>
		inputs.length === 0
			? refuse('Nothing to write.')
			: Effect.succeed(inputs.map((input) => ({ ...input, note: input.note ?? 'transformed' })))
});

/** A plain Error is a defect, not an authored refusal, and cannot inhabit a transform's error channel. */
const invalidFailureChannel = defineCollection({
	model: runs,
	create: { input: { columns: { company_id: true, period: true } } },
	// @ts-expect-error a transform may fail only with AuthoredRefusal
	transform: () => Effect.fail(new Error('not an authored refusal'))
});

type RunsApi = CollectionWriteApi<TestSchema, 'payroll_runs', typeof runsCollection>;

/** Only the declared operations exist, each typed by its declared input. */
const writeSurface = (api: RunsApi) => {
	api.create({ company_id: 'c', period: '2026-08' });
	api.createMany([{ company_id: 'c', period: '2026-08', note: 'n' }]);
	api.delete('r');
	api.deleteMany(['r']);
	// @ts-expect-error — the declaration has no update
	api.update('r', { note: 'n' });
	// @ts-expect-error — total is outside the create selection
	api.create({ company_id: 'c', period: '2026-08', total: 1 });
};

describe('the declared write graph', () => {
	it('admits the shapes above and rejects the ones marked, at compile time', () => {
		expect([
			flat,
			nested,
			deep,
			everyAction,
			typo,
			bareRows,
			wrongChildColumn,
			writesTheForeignKey,
			expandsAOneRelation,
			updateWithoutId,
			claimsAnId,
			createInput,
			createInputWithNote,
			updateInput,
			createMissingRequired,
			createOutsideSelection,
			createWrongType,
			runsCollection,
			invalidFailureChannel,
			writeSurface
		]).toHaveLength(20);
	});
});
