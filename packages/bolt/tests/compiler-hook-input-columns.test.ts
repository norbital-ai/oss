import { describe, expect, it } from 'vitest';
import { declaredHookInputColumns } from '../src/compiler/workspace-build.js';

describe('declared hook input columns', () => {
	it('reads the columns a declared input names', () => {
		const columns = declaredHookInputColumns(`
			import { schema } from '@norbital-ai/bolt/authoring';

			export default {
				input: schema('payroll_runs', { columns: { company_id: true, period: true } }),
				mutate: {}
			};
		`);
		expect(columns).toEqual(['company_id', 'period']);
	});

	it('reads string-keyed columns and ignores non-true values', () => {
		const columns = declaredHookInputColumns(`
			export default {
				input: schema('evidence', {
					columns: {
						photo: true,
						'source.kind': false,
						derived_by_hook: 'PREPARED'
					}
				})
			};
		`);
		expect(columns).toEqual(['photo']);
	});

	it('reads a same-file Schema.Struct const the input names', () => {
		const columns = declaredHookInputColumns(`
			import { Effect, Schema } from 'effect';

			const createRunInput = Schema.Struct({
				company_id: Schema.String.check(Schema.isUUID()),
				period: Schema.String.check(
					Schema.isPattern(/^\\d{4}-(0[1-9]|1[0-2])$/, { message: 'must be YYYY-MM.' })
				)
			});

			export default {
				input: createRunInput,
				mutate: { perRecord: { before: { description: 'build', handler: () => Effect.void } } }
			};
		`);
		expect(columns).toEqual(['company_id', 'period']);
	});

	it('reads an inline Schema.Struct', () => {
		const columns = declaredHookInputColumns(`
			export default { input: Schema.Struct({ photo: Schema.Unknown, source: Schema.Unknown }) };
		`);
		expect(columns).toEqual(['photo', 'source']);
	});

	it('falls back to the whole collection when the declaration names no columns', () => {
		const open = declaredHookInputColumns(`
			export default { input: schema('work_days'), mutate: {} };
		`);
		expect(open).toBeUndefined();

		const noInput = declaredHookInputColumns(`
			export default { mutate: { perRecord: { before: {} } } };
		`);
		expect(noInput).toBeUndefined();
	});

	it('falls back when the config is not a literal this pass can read', () => {
		const built = declaredHookInputColumns(`
			const config = { columns: { a: true } };
			export default { input: schema('x', config) };
		`);
		expect(built).toBeUndefined();
	});
});
