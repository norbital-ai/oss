import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { Files } from '../../src/runtime/facilities/services.js';
import { readSkill } from '../../src/runtime/agents/agents.js';
import { testCallContext } from '../support/bolt-test-layer.js';

const context = testCallContext('skills-test');

describe('Agent skills owner', () => {
	it('bounds names before accessing the file facility', async () => {
		const layer = Files.layer(undefined, context);
		const error = await Effect.runPromise(
			Effect.flip(
				readSkill(EffectId.make('skill-invalid'), '../escape').pipe(Effect.provide(layer))
			)
		);
		expect(error._tag).toBe('Bolt.Agents.SkillError');
		if (error._tag === 'Bolt.Agents.SkillError') expect(error.reason).toBe('invalid-name');
	});

	it('reads one canonical SKILL.md path without process-local state', async () => {
		const keys: Array<string> = [];
		const layer = Files.layer(
			{
				call: (_metadata, request) => {
					if (request._tag === 'Read') keys.push(request.key);
					return Promise.resolve({
						_tag: 'Success',
						value: { bytes: new TextEncoder().encode('# Payroll') }
					});
				}
			},
			context
		);
		const value = await Effect.runPromise(
			readSkill(EffectId.make('skill-read'), 'payroll').pipe(Effect.provide(layer))
		);
		expect(value).toBe('# Payroll');
		expect(keys).toEqual(['skills/payroll/SKILL.md']);
	});
});
