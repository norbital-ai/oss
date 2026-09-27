// The agent panel's projections (L-BOLT-436, L-BOLT-546, L-BOLT-547): pure functions of the transcript rows.
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/protocol/wire.ts';
import { checkpointSections, contextView, modelDividers, ORB, orbState, revisable, type Orb } from '../src/shell/agent-view.ts';

const row = (seq: number, o: Partial<AgentRow> = {}): AgentRow => ({ id: `m${seq}`, seq, role: 'user', text: `t${seq}`, state: 'consumed', tag: null, ...o });
const reply = (seq: number, model?: string, tag = 'reply'): AgentRow => row(seq, { role: 'assistant', tag, ...(model === undefined ? {} : { usage: { input: 1, output: 1, calls: 1, model } }) });

describe('the orb (L-BOLT-436)', () => {
	it('gives every state its own named mark: waiting on a person is not failing, finished and stopped are not idle', () => {
		const cases: [Orb, Parameters<typeof orbState>[0]][] = [
			['ready', { status: 'idle', rows: [] }],
			['working', { status: 'running', rows: [] }],
			['waiting', { status: 'idle', rows: [row(1, { role: 'tool', state: 'confirm', tag: 'confirm' })] }],
			['failed', { status: 'idle', rows: [reply(1, undefined, 'failed')] }],
			['done', { status: 'idle', rows: [reply(1)] }],
			['stopped', { status: 'stopped', rows: [reply(1)] }],
		];
		for (const [mark, input] of cases) expect(orbState(input)).toBe(mark);
		expect(new Set(Object.values(ORB).map((o) => o.label)).size).toBe(Object.keys(ORB).length);
	});
	it('lets the caller override: a turn it just dispatched works, a send it saw fail outranks the status', () => {
		expect(orbState({ status: 'idle', rows: [reply(1)], pending: true })).toBe('working');
		expect(orbState({ status: 'running', rows: [], failed: true })).toBe('failed');
	});
});

describe('the context view (L-BOLT-546)', () => {
	it('puts summarized rows outside, but not the rows the checkpoint kept, input still waiting or anything after it', () => {
		const rows = [row(1), reply(2), row(3, { state: 'queued' }), row(4),
			row(5, { role: 'system', tag: 'compact', compact: { cutoff: 4, keep: ['m4'], origin: 'requested' } }), row(6)];
		const view = contextView(rows, null);
		expect([...view.outside]).toEqual(['m1', 'm2']);
		expect(view.origin).toBe('requested');
	});
	it('a draft plan moves nothing; an executed one puts the discussion before it outside', () => {
		const rows = [row(1), reply(2), row(3), reply(4)];
		expect(contextView(rows, { revision: 1, body: 'p', status: 'draft', checkpoint: 0 }).outside.size).toBe(0);
		expect([...contextView(rows, { revision: 2, body: 'p', status: 'active', checkpoint: 2 }).outside]).toEqual(['m1', 'm2']);
	});
	it('the context segment holds everything up to the boundary and the checkpoint it shows; a later executed plan takes over', () => {
		const cp = row(5, { role: 'system', tag: 'compact', compact: { cutoff: 4, keep: ['m4'], origin: 'manual' } });
		const rows = [row(1), reply(2), row(3, { state: 'queued' }), row(4), cp, row(6), reply(7)];
		const view = contextView(rows, null);
		expect([...view.history]).toEqual(['m1', 'm2', 'm4', 'm5']);
		expect(view.checkpoint?.id).toBe('m5');
		const planned = contextView(rows, { revision: 1, body: 'p', status: 'active', checkpoint: 6 });
		expect(planned.checkpoint).toBeNull();
		expect([...planned.history]).toEqual(['m1', 'm2', 'm4', 'm5', 'm6']);
		expect(contextView(rows, { revision: 1, body: 'p', status: 'draft', checkpoint: 0 }).checkpoint?.id).toBe('m5');
	});
	it('shows a checkpoint table as headed sections, and other text as it came', () => {
		expect(checkpointSections('| Row | Summary |\n|---|---|\n| Goal | Pay run |\n| What\'s left | Approve |')).toBe('#### Goal\n\nPay run\n\n#### What\'s left\n\nApprove');
		expect(checkpointSections('plain text')).toBe('plain text');
	});
	it('revises only a plain-text message of the person', () => {
		expect(revisable(row(1))).toBe(true);
		expect(revisable(row(1, { files: [{ name: 'a.pdf', mime: 'application/pdf' }] }))).toBe(false);
		expect(revisable(reply(1))).toBe(false);
	});
});

describe('the model-change divider (L-BOLT-547)', () => {
	it('marks every change, a switch back too, and nothing between replies of one model; a reply with no model is skipped', () => {
		const rows = [row(1), reply(2, 'fast'), row(3), reply(4, 'strong'), reply(5), reply(6, 'strong'), reply(7, 'fast')];
		expect([...modelDividers(rows)]).toEqual([['m4', 'strong'], ['m7', 'fast']]);
		expect([...modelDividers(rows)]).toEqual([...modelDividers(rows.map((r) => ({ ...r })))]);
	});
});
