import { describe, expect, it } from 'vitest';
import {
	parseStoredSummary,
	resolveAgentIntent,
	windowContentFromStoredSummary,
	wrapPlanSummary
} from '$lib/shared/agent/intent.js';

describe('resolveAgentIntent', () => {
	it('infers verify from the message, plan mode, and an explicit prompt', () => {
		expect(resolveAgentIntent({ message: 'hello' }).verify).toBe(false);
		expect(resolveAgentIntent({ message: "how's the weather" }).verify).toBe(false);
		expect(resolveAgentIntent({ message: 'thanks' }).verify).toBe(false);

		expect(resolveAgentIntent({ message: 'create the site' }).verify).toBe(true);
		expect(resolveAgentIntent({ planMode: true }).verify).toBe(true);
		expect(
			resolveAgentIntent({ verifierPrompt: '  Was the site actually written?  ' })
		).toMatchObject({
			verify: true,
			verifierPrompt: 'Was the site actually written?'
		});
	});
});

describe('plan summary wrapping', () => {
	it('wraps and parses a plan recap, and re-enters the window under the matching tags', () => {
		const recap = 'Migrate sites first, then payments.';
		const wrapped = wrapPlanSummary(recap);
		expect(parseStoredSummary(wrapped)).toEqual({ fold: 'plan', text: recap });
		expect(parseStoredSummary(`<plan-summary>${recap}</plan-summary>`)).toEqual({
			fold: 'plan',
			text: recap
		});
		expect(parseStoredSummary('They asked X.')).toEqual({
			fold: 'compact',
			text: 'They asked X.'
		});
		expect(windowContentFromStoredSummary(wrapped)).toBe(
			'<plan-summary>\nMigrate sites first, then payments.\n</plan-summary>'
		);
		expect(windowContentFromStoredSummary('They asked X.')).toBe(
			'<conversation-summary>\nThey asked X.\n</conversation-summary>'
		);
	});
});
