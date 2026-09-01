import { describe, expect, it } from 'vitest';
import {
	isAgentModeShortcut,
	parseTaskSlashCommand
} from '../../src/client/ui/agent/intent.js';

describe('Task composer intent', () => {
	it('parses only plan and compact submissions without storing their prefixes', () => {
		expect(parseTaskSlashCommand('/PLAN\nresearch the migration\nthen write a plan')).toEqual({
			kind: 'submission',
			mode: 'plan',
			message: 'research the migration\nthen write a plan',
			complete: true
		});
		expect(parseTaskSlashCommand('/compact   keep the decisions and open risks')).toEqual({
			kind: 'submission',
			mode: 'compact',
			message: 'keep the decisions and open risks',
			complete: true
		});
	});

	it('requires submission instructions, rejects Goal, and leaves similar commands as messages', () => {
		expect(parseTaskSlashCommand('/plan')).toEqual({
			kind: 'submission',
			mode: 'plan',
			message: '',
			complete: false
		});
		expect(parseTaskSlashCommand('/goal ship it')).toEqual({
			kind: 'message',
			message: '/goal ship it'
		});
		expect(parseTaskSlashCommand('/planner is a normal message')).toEqual({
			kind: 'message',
			message: '/planner is a normal message'
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
