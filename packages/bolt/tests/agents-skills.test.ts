import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { describeSkill } from '../src/authoring/workspace-schema.js';
import { readSkillBody } from '../src/runtime/agents/capability-catalog.js';
import * as authoring from '../src/authoring/index.js';
import { PLATFORM_SKILLS } from '../src/runtime/agents/platform-skills.js';

const payroll = describeSkill('payroll', '# Payroll\n\nUse the approved payroll workflow.');

describe('Agent skills owner', () => {
	it('the injected authoring examples use exported builders', () => {
		for (const skill of PLATFORM_SKILLS) {
			for (const match of skill.body.matchAll(
				/import \{ ([^}]+) \} from '@norbital-ai\/bolt\/authoring';/g
			)) {
				for (const name of match[1]!.split(',').map((name) => name.trim())) {
					expect(authoring[name as keyof typeof authoring], name).toBeTypeOf('function');
				}
			}
		}
	});

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
