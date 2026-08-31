import { describe, expect, it } from 'vitest';
import {
	isAgentModeShortcut,
	parseAgentSlashCommand,
	resolveAgentIntent
} from '../../src/client/ui/agent/intent.js';

describe('agent composer intent', () => {
	it('parses goal, plan, and compact commands without storing their prefixes', () => {
		expect(parseAgentSlashCommand('/goal implement the billing invariant')).toEqual({
			command: 'goal',
			message: 'implement the billing invariant',
			complete: true
		});
		expect(parseAgentSlashCommand('/PLAN\nresearch the migration\nthen write a plan')).toEqual({
			command: 'plan',
			message: 'research the migration\nthen write a plan',
			complete: true
		});
		expect(parseAgentSlashCommand('/compact   keep the decisions and open risks')).toEqual({
			command: 'compact',
			message: 'keep the decisions and open risks',
			complete: true
		});
	});

	it('requires command instructions and leaves similar prose untouched', () => {
		expect(parseAgentSlashCommand('/goal')).toEqual({
			command: 'goal',
			message: '',
			complete: false
		});
		expect(parseAgentSlashCommand('/planner is a normal message')).toEqual({
			command: null,
			message: '/planner is a normal message',
			complete: true
		});
	});

	it('makes goal verification explicit and compact turns checkpoint-only', () => {
		expect(resolveAgentIntent({ message: 'ship it', goal: true })).toMatchObject({
			intent: 'do',
			verify: true,
			verifierPrompt: 'Determine whether this exact goal is fully complete:\nship it'
		});
		expect(resolveAgentIntent({ message: 'retain open risks', intent: 'compact' })).toMatchObject({
			intent: 'compact',
			verify: false,
			foldAsCheckpoint: true
		});
	});

	it('uses only unmodified Tab as the mode shortcut', () => {
		const event = {
			key: 'Tab',
			shiftKey: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			isComposing: false
		};
		expect(isAgentModeShortcut(event)).toBe(true);
		expect(isAgentModeShortcut({ ...event, shiftKey: true })).toBe(false);
		expect(isAgentModeShortcut({ ...event, isComposing: true })).toBe(false);
		expect(isAgentModeShortcut({ ...event, key: 'Enter' })).toBe(false);
	});
});
