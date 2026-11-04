import { expect, it } from 'vitest';
import { attention, awaitingAfter, endingSound, settled } from '../src/shell/agent/chime.ts';
import type { AgentRow } from '../src/protocol/schema.ts';

const held: AgentRow = {
	id: 'approval',
	seq: 3,
	role: 'tool',
	text: null,
	state: 'confirm',
	tag: 'confirm'
};
const asked: AgentRow = {
	id: 'input',
	seq: 1,
	role: 'user',
	text: 'Build it',
	state: 'consumed',
	tag: null
};
const reply = (id: string, text: string, tag = 'reply', at = '2026-11-04T05:00:01Z'): AgentRow => ({
	id,
	seq: 2,
	role: 'assistant',
	text,
	state: null,
	tag,
	at,
	turn: 't1'
});

it('sounds only for new approvals and new turn endings, never history, chat switches or a reply still streaming', () => {
	const event = attention();
	expect(event('one', [held])).toBeNull();
	expect(event('one', [held, { ...held, id: 'new' }])).toBe('input');
	expect(event('one', [asked, { ...reply('r1', 'Done.'), state: 'streaming' }])).toBeNull();
	// a turn too brief for its running status ever to be seen still ends with its reply
	expect(event('one', [asked, reply('r1', 'Done.')])).toBe('complete');
	expect(event('one', [asked, reply('r1', 'Done.')])).toBeNull();
	expect(event('two', [asked, reply('r2', 'Done.')])).toBeNull();
	expect(event(null, [])).toBeNull();
});

it('a turn ends finished, asking the person, or failed', () => {
	expect(endingSound([asked, reply('r', 'Built change !2 and verified it.')])).toBe('complete');
	expect(endingSound([asked, reply('r', 'Which do you want: the upload or the token?')])).toBe(
		'input'
	);
	expect(endingSound([asked, reply('r', 'Use `a ? b : c` here.')])).toBe('complete');
	expect(endingSound([asked, { ...held, turn: 't1' }, reply('r', 'Waiting on you.')])).toBe(
		'input'
	);
	expect(endingSound([asked, reply('r', 'The model call failed.', 'failed')])).toBe('error');
	// a click on the person's tab waits for their confirmation until the tab answers
	const click: AgentRow = {
		id: 'click',
		seq: 2,
		role: 'tool',
		text: null,
		state: null,
		tag: null,
		turn: 't1',
		tool: { name: 'page_act', failed: false, page: { click: 'New' } }
	};
	expect(endingSound([asked, click, reply('r', 'Asked your page to click New.')])).toBe('input');
	expect(
		endingSound([
			asked,
			{ ...click, tool: { ...click.tool!, pageResult: { ok: true } } },
			reply('r', 'Opened it.')
		])
	).toBe('complete');
	expect(endingSound([asked])).toBeNull();
	// a closed conversation's ending sounds only when it was written after its last activity was seen
	expect(endingSound([asked, reply('r', 'Done.')], '2026-11-04T05:00:00Z')).toBe('complete');
	expect(endingSound([asked, reply('r', 'Done.')], '2026-11-04T05:00:01Z')).toBeNull();
});

it('a closed personal conversation that went idle with new activity may have ended a turn', () => {
	const ended = settled();
	const row = { id: 'one', integration: null, status: 'idle', at: '2026-11-04T05:00:00Z' };
	expect(ended([row])).toEqual([]);
	expect(ended([row])).toEqual([]);
	// never seen running: its activity still moved while idle
	expect(ended([{ ...row, at: '2026-11-04T05:00:05Z' }])).toEqual([
		{ id: 'one', since: '2026-11-04T05:00:00Z' }
	]);
	expect(ended([{ ...row, at: '2026-11-04T05:00:05Z', status: 'running' }])).toEqual([]);
	expect(ended([{ ...row, at: '2026-11-04T05:00:05Z' }])).toEqual([
		{ id: 'one', since: '2026-11-04T05:00:05Z' }
	]);
	ended([{ ...row, integration: 'whatsapp', status: 'running' }]);
	expect(ended([{ ...row, integration: 'whatsapp', at: '2026-11-04T05:09:00Z' }])).toEqual([]);
});

it('the Norbius icon keeps the most pressing unseen ending', () => {
	expect(awaitingAfter(null, 'complete')).toBe('complete');
	expect(awaitingAfter('complete', 'input')).toBe('input');
	expect(awaitingAfter('input', 'complete')).toBe('input');
	expect(awaitingAfter('input', 'error')).toBe('error');
	expect(awaitingAfter('error', 'input')).toBe('error');
	expect(awaitingAfter(null, 'notification')).toBeNull();
});
