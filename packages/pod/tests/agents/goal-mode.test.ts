import { describe, expect, it } from 'vitest';
import {
	parseGoalVerdict,
	parseStoredGoalVerdict,
	serializeGoalVerdict,
	UNREADABLE_VERDICT
} from '$lib/shared/agent/goal-verdict.js';
import {
	acceptGoalStop,
	GOAL_MODE_REMINDER,
	MAX_GOAL_VERIFICATIONS,
	renderGoalContinuation,
	goalContinuationMessage,
	windowMessageFromStoredGoal
} from '$lib/server/agent/goal-mode.server.js';
import { composeSystemPrompt, PLAN_MODE_REMINDER } from '$lib/server/agent/system-prompt.js';

describe('goal verdict parsing', () => {
	it('accepts raw JSON', () => {
		expect(parseGoalVerdict('{"achieved":true,"summary":"Done","gaps":[]}')).toEqual({
			achieved: true,
			summary: 'Done',
			gaps: []
		});
	});

	it('accepts fenced json', () => {
		expect(
			parseGoalVerdict('```json\n{"achieved":true,"summary":"Done","gaps":[]}\n```')
		).toEqual({
			achieved: true,
			summary: 'Done',
			gaps: []
		});
	});

	it('returns unreadable for garbage, missing fields, and achieved without summary', () => {
		expect(parseGoalVerdict('not json')).toEqual(UNREADABLE_VERDICT);
		expect(parseGoalVerdict('{"achieved":true}')).toEqual(UNREADABLE_VERDICT);
		expect(parseGoalVerdict('{"achieved":true,"summary":"","gaps":[]}')).toEqual(
			UNREADABLE_VERDICT
		);
		expect(UNREADABLE_VERDICT.achieved).toBe(false);
	});
});

describe('stored goal verdict', () => {
	it('round-trips through serialize and parseStored', () => {
		const verdict = {
			achieved: false,
			summary: 'No site record exists.',
			gaps: ['write_collection never ran']
		};
		expect(parseStoredGoalVerdict(serializeGoalVerdict(verdict))).toEqual(verdict);
	});

	it('returns null for non-goal_verdict JSON', () => {
		expect(parseStoredGoalVerdict('{"resultType":"other"}')).toBeNull();
		expect(parseStoredGoalVerdict('{"achieved":true,"summary":"x","gaps":[]}')).toBeNull();
	});
});

describe('acceptGoalStop', () => {
	const achieved = { achieved: true, summary: 'Done', gaps: [] as string[] };
	const failed = {
		achieved: false,
		summary: 'Still missing work.',
		gaps: ['gap one']
	};

	it('accepts an achieved verdict on the first attempt', () => {
		expect(acceptGoalStop(achieved, 1)).toBe(true);
	});

	it('rejects a failed verdict before the cap', () => {
		expect(acceptGoalStop(failed, 1)).toBe(false);
		expect(acceptGoalStop(failed, MAX_GOAL_VERIFICATIONS - 1)).toBe(false);
	});

	it('fail-closes on the last allowed attempt', () => {
		expect(acceptGoalStop(failed, MAX_GOAL_VERIFICATIONS)).toBe(true);
	});
});

describe('goal continuation messages', () => {
	it('wraps renderGoalContinuation in a goal-verification user message', () => {
		const verdict = {
			achieved: false,
			summary: 'No site record exists.',
			gaps: ['write_collection never ran']
		};
		expect(goalContinuationMessage(verdict)).toEqual({
			role: 'user',
			content: `<goal-verification>\n${renderGoalContinuation(verdict)}\n</goal-verification>`
		});
	});

	it('uses unreadable verdict for stored garbage without throwing', () => {
		const message = windowMessageFromStoredGoal('not goal json');
		expect(message.role).toBe('user');
		expect(message.content).toContain('<goal-verification>');
		expect(message.content).toContain(renderGoalContinuation(UNREADABLE_VERDICT));
	});
});

describe('composeSystemPrompt goal and plan modes', () => {
	it('prefers plan mode when both are set', () => {
		const prompt = composeSystemPrompt(undefined, { planMode: true, goalMode: true });
		expect(prompt).toContain(PLAN_MODE_REMINDER);
		expect(prompt).not.toContain(GOAL_MODE_REMINDER);
	});

	it('includes goal mode when plan mode is off', () => {
		const prompt = composeSystemPrompt(undefined, { goalMode: true });
		expect(prompt).toContain(GOAL_MODE_REMINDER);
		expect(prompt).not.toContain(PLAN_MODE_REMINDER);
	});
});
