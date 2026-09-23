import { describe, expect, it } from 'vitest';
import {
	COMPOSER_COMMANDS,
	commandMenuItems,
	findCommandTrigger,
	selectComposerCommand
} from '../src/client/ui/agent/composer-commands.js';
import { parseTaskSlashCommand } from '../src/client/ui/agent/intent.js';

describe('AGENT-UI4 the / command menu', () => {
	it('opens for a / at the start of the draft with plan, compact and export', () => {
		expect(findCommandTrigger('/', 1)).toEqual({ query: '' });
		expect(commandMenuItems('')).toEqual([
			{ kind: 'composer-command', command: 'plan' },
			{ kind: 'composer-command', command: 'compact' },
			{ kind: 'composer-command', command: 'export' }
		]);
		expect(findCommandTrigger('/pl', 3)).toEqual({ query: 'pl' });
		expect(commandMenuItems('pl')).toEqual([{ kind: 'composer-command', command: 'plan' }]);
		expect(commandMenuItems('COM')).toEqual([{ kind: 'composer-command', command: 'compact' }]);
		expect(commandMenuItems('x')).toEqual([]);
	});

	it('opens nothing for a / mid-sentence, after a space, or once the name is complete', () => {
		expect(findCommandTrigger('rate is 1/2', 11)).toBeNull();
		expect(findCommandTrigger('see /plan', 9)).toBeNull();
		expect(findCommandTrigger(' /plan', 6)).toBeNull();
		expect(findCommandTrigger('/plan ', 6)).toBeNull();
		expect(findCommandTrigger('/plan the rollout', 17)).toBeNull();
		expect(findCommandTrigger('/', 0)).toBeNull();
		expect(findCommandTrigger('', 0)).toBeNull();
		expect(findCommandTrigger('/thisisnotacommandname', 22)).toBeNull();
	});

	it('lifts the selected command out and leaves only the message text', () => {
		expect(selectComposerCommand('/', { query: '' })).toBe('');
		expect(selectComposerCommand('/pl', { query: 'pl' })).toBe('');
		expect(selectComposerCommand('/co', { query: 'co' })).toBe('');
		// Text after the query survives, and the leading space is not part of the message.
		expect(selectComposerCommand('/p rollout', { query: 'p' })).toBe('rollout');
	});

	it('offers the commands the send path parses, plus /export which sends nothing', () => {
		for (const command of COMPOSER_COMMANDS) {
			expect(parseTaskSlashCommand(`/${command} x`)).toMatchObject(
				command === 'export' ? { kind: 'message' } : { kind: 'submission', mode: command }
			);
		}
	});
});
