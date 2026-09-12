import { describe, expect, it } from 'vitest';
import {
	COMPOSER_COMMANDS,
	commandMenuItems,
	findCommandTrigger,
	selectComposerCommand
} from '../src/client/ui/agent/composer-commands.js';
import { parseTaskSlashCommand } from '../src/client/ui/agent/intent.js';

describe('AGENT-UI4 the / command menu', () => {
	it('opens for a / at the start of the draft with plan and compact', () => {
		expect(findCommandTrigger('/', 1)).toEqual({ query: '' });
		expect(commandMenuItems('')).toEqual([
			{ kind: 'composer-command', command: 'plan' },
			{ kind: 'composer-command', command: 'compact' }
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

	it('lifts the selected command into a mode and leaves only the message text', () => {
		expect(selectComposerCommand('/', { query: '' }, 'plan')).toEqual({
			mode: 'plan',
			message: '',
			caret: 0
		});
		expect(selectComposerCommand('/pl', { query: 'pl' }, 'plan')).toEqual({
			mode: 'plan',
			message: '',
			caret: 0
		});
		expect(selectComposerCommand('/co', { query: 'co' }, 'compact')).toEqual({
			mode: 'compact',
			message: '',
			caret: 0
		});
		// Text after the query survives, and the leading space is not part of the message.
		expect(selectComposerCommand('/p rollout', { query: 'p' }, 'plan')).toEqual({
			mode: 'plan',
			message: 'rollout',
			caret: 0
		});
	});

	it('offers exactly the commands the send path parses', () => {
		for (const command of COMPOSER_COMMANDS) {
			expect(parseTaskSlashCommand(`/${command} x`)).toMatchObject({ kind: 'submission', mode: command });
		}
	});
});
