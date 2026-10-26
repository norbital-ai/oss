/// <reference types="node" />
// Studio's Audit rules page edits a draft rule set: a state equal to the rule's declared severity is not stored, path
// scopes are one glob per line, and the own rules' editor text is a JSON array of rule objects or a reason it is not.
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	byPack,
	withIgnore,
	withOwn,
	withState,
	type AuditRuleSet,
	type StudioAuditRule
} from '../src/shell/studio/audit.ts';

const rule = (id: string, pack: string): StudioAuditRule => ({
	id,
	pack,
	summary: id,
	severity: 'error',
	state: 'error',
	principles: ['simplicity'],
	examples: { bad: ['a'], good: ['b'] }
});
const empty: AuditRuleSet = { states: {}, ignore: [], rules: [] };

it.effect('the draft stores only states that differ from the declared severity', () =>
	Effect.sync(() => {
		const hinted = withState(empty, rule('UI12', 'layout'), 'hint');
		expect(hinted.states).toEqual({ UI12: 'hint' });
		expect(withState(hinted, rule('UI12', 'layout'), 'error').states).toEqual({});
		expect(withIgnore(empty, ' vendor/**\n\n  dist/** ').ignore).toEqual(['vendor/**', 'dist/**']);
	})
);

it.effect("own rules are a JSON array of objects, and packs list the organization's last", () =>
	Effect.sync(() => {
		expect(withOwn(empty, '[{"id":"NoConsoleLog"}]')).toEqual({
			ruleSet: { ...empty, rules: [{ id: 'NoConsoleLog' }] }
		});
		expect(withOwn(empty, '{"id":"x"}')).toHaveProperty('error');
		expect(withOwn(empty, '[1]')).toHaveProperty('error');
		expect(withOwn(empty, 'nope')).toHaveProperty('error');
		expect(
			byPack([rule('Own', 'organization'), rule('UI5', 'layout'), rule('R1', 'boundaries')]).map(
				([pack]) => pack
			)
		).toEqual(['boundaries', 'layout', 'organization']);
	})
);
