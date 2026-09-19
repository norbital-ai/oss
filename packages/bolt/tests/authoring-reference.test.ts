import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { OUTPUT, render } from '../scripts/authoring-reference.mjs';
import { AUTHORING_REFERENCE } from '../src/runtime/agents/authoring-reference.generated.js';
import { PLATFORM_SKILLS } from '../src/runtime/agents/platform-skills.js';
import { executeSystemTool, skillSections } from '../src/runtime/agents/capability-catalog.js';

/**
 * The reference is the built declarations, so it can only drift by someone changing
 * `src/authoring` and not regenerating. This is the gate: it needs `pnpm build` first, which is
 * how CI orders it.
 */
describe('the authoring reference is generated, never written', () => {
	it('matches the built declarations exactly', () => {
		expect(readFileSync(fileURLToPath(new URL(OUTPUT, import.meta.url)), 'utf8')).toBe(render());
	});

	it('carries the surface an author reaches for, doc comments included', () => {
		const titles = AUTHORING_REFERENCE.map(({ title }) => title);
		expect(titles).toEqual([
			'Server api',
			'Automations',
			'Collections and notifications',
			'Model columns',
			'Policies, approvals, teams',
			'Functions'
		]);
		const automations = AUTHORING_REFERENCE[1]!.body;
		expect(automations).toContain('export type AutomationTrigger');
		expect(automations).toContain('export declare const defineAutomation');
		const collections = AUTHORING_REFERENCE[2]!.body;
		expect(collections).toContain('export interface CollectionLifecycleEvent');
		expect(collections).toContain('NotificationChannels');
	});

	it('is read by section through read_skill, and the sections are listed', async () => {
		const skill = PLATFORM_SKILLS[0]!;
		const sections = skillSections(skill.body);
		expect(sections).toContain('Automations');
		expect(sections).toContain('Method');
		const context = { skills: PLATFORM_SKILLS, toolNames: [] } as never;
		const whole = (await run(executeSystemTool('read_skill', { name: skill.name }, context))) as {
			body: string;
		};
		const one = (await run(
			executeSystemTool('read_skill', { name: skill.name, section: 'automations' }, context)
		)) as { body: string; section: string };
		expect(one.section).toBe('automations');
		expect(one.body.startsWith('## Automations')).toBe(true);
		expect(one.body).toContain('defineAutomation');
		expect(one.body.length).toBeLessThan(whole.body.length / 3);
		await expect(
			run(executeSystemTool('read_skill', { name: skill.name, section: 'nope' }, context))
		).rejects.toThrow(/missing/);
	});
});

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
	Effect.runPromise(effect as never);
