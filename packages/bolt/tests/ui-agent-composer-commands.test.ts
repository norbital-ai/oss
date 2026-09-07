import { describe, expect, it } from 'vitest';
import {
	COMPOSER_COMMANDS,
	commandMenuItems,
	findCommandTrigger,
	insertCommand
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

	it('leaves "/plan " in the composer after a selection, with the caret after it', () => {
		expect(insertCommand('/', { query: '' }, 'plan')).toEqual({ draft: '/plan ', caret: 6 });
		expect(insertCommand('/pl', { query: 'pl' }, 'plan')).toEqual({ draft: '/plan ', caret: 6 });
		expect(insertCommand('/co', { query: 'co' }, 'compact')).toEqual({
			draft: '/compact ',
			caret: 9
		});
		// Text after the caret survives, and an existing space is not doubled.
		expect(insertCommand('/p rollout', { query: 'p' }, 'plan')).toEqual({
			draft: '/plan rollout',
			caret: 6
		});
		// The inserted draft closes the menu and is what the send path already parses.
		const inserted = insertCommand('/', { query: '' }, 'plan');
		expect(findCommandTrigger(inserted.draft, inserted.caret)).toBeNull();
		expect(parseTaskSlashCommand(inserted.draft)).toMatchObject({ kind: 'submission', mode: 'plan' });
	});

	it('offers exactly the commands the send path parses', () => {
		for (const command of COMPOSER_COMMANDS) {
			expect(parseTaskSlashCommand(`/${command} x`)).toMatchObject({ kind: 'submission', mode: command });
		}
	});
});
