import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { describeSkill } from '../../src/authoring/workspace-schema.js';
import { readSkillBody } from '../../src/runtime/agents/capability-catalog.js';

const payroll = describeSkill('payroll', '# Payroll\n\nUse the approved payroll workflow.');

describe('Agent skills owner', () => {
	it.effect('bounds names before reading the compiled registry', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(readSkillBody([payroll], '../escape'));
			expect(error._tag).toBe('Bolt.CapabilityCatalog.SkillError');
			expect(error.reason).toBe('invalid-name');
		})
	);

	it.effect('reads only from the policy-filtered compiled registry', () =>
		Effect.gen(function* () {
			expect(yield* readSkillBody([payroll], 'payroll')).toContain('approved payroll');
			const hidden = yield* Effect.flip(readSkillBody([], 'payroll'));
			expect(hidden.reason).toBe('missing');
		})
	);
});
