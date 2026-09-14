import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { PlatformRelationshipsFor } from '../src/authoring/internals.js';
import { cascade, deferrable, defineModel, setNull, uuid } from '../src/authoring/index.js';
import { compileWorkspaceAuthoring } from '../src/authoring/model-introspection.js';
import { planWorkspaceMigration } from '../src/compiler/schema-migrations.js';

const models = {
	payroll_runs: defineModel({ period_id: uuid() }),
	payslips: defineModel({ payroll_run_id: uuid().notNull() }),
	work_days: defineModel({ payslip_id: uuid() })
};

const relationships = ((r) => ({
	payroll_runs: { payslips: r.many.payslips() },
	payslips: {
		run: cascade(r.one.payroll_runs({ from: r.payslips.payroll_run_id, to: r.payroll_runs.id }))
	},
	work_days: {
		payslip: deferrable(
			setNull(r.one.payslips({ from: r.work_days.payslip_id, to: r.payslips.id }))
		)
	}
})) satisfies PlatformRelationshipsFor<typeof models>;

const compiled = compileWorkspaceAuthoring({
	models,
	sourcePaths: Object.fromEntries(
		Object.keys(models).map((name) => [name, `src/collections/${name}/+model.ts`])
	),
	relationships
});

/**
 * A run pins its entries before its payslips insert. The existence check has to wait for commit, and
 * the clause has to be emitted by this compiler because drizzle-kit has no builder for it.
 */
describe('deferrable relations', () => {
	it('carries the flag onto the relation it wraps', () => {
		const payslip = compiled.relationships.find(({ name }) => name === 'payslip');
		expect(payslip?.setNull).toBe(true);
		expect(payslip?.deferrable).toBe(true);
	});

	it('leaves an unwrapped relation immediate', () => {
		expect(compiled.relationships.find(({ name }) => name === 'run')?.deferrable).toBeUndefined();
	});

	it('emits DEFERRABLE INITIALLY DEFERRED for a flagged key and not for an unflagged one', async () => {
		const migration = await Effect.runPromise(
			planWorkspaceMigration({ authoring: compiled, previous: undefined })
		);
		if (migration === undefined) throw new Error('a schema built from nothing must produce DDL');
		const ddl = migration.statements.join('\n');
		expect(ddl).toContain(
			'ADD CONSTRAINT "work_days_payslip_id_payslips_fk" FOREIGN KEY ("payslip_id") ' +
				'REFERENCES "payslips"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;'
		);
		expect(ddl).toContain(
			'ADD CONSTRAINT "payslips_payroll_run_id_payroll_runs_fk" FOREIGN KEY ("payroll_run_id") ' +
				'REFERENCES "payroll_runs"("id") ON DELETE CASCADE;'
		);
	});
});
