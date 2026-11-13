import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { revisionAction, TIMELINE_ICON, type TimelineAction } from '../src/timeline/timeline.ts';
import type { Checkpoint } from '../src/record/history.ts';
import { browser, required, textOf } from './view-fixture.ts';
const { flushSync, mount, unmount } = await import('svelte');
const { default: Timeline } = await import('../src/timeline/Timeline.svelte');

const at = (more: Partial<Checkpoint>): Checkpoint => ({
	revision: 2,
	at: '2026-11-13T11:49:00Z',
	actor: null,
	fields: ['title'],
	restored_from: null,
	approval: null,
	valid: true,
	...more
});

it('every action has its own icon, and a revision names what it did', () => {
	const icons: Readonly<Record<TimelineAction, string>> = {
		request: 'send',
		resubmit: 'sync',
		request_changes: 'messageWarning',
		approve: 'circleCheck',
		reject: 'circleX',
		withdraw: 'undo',
		supersede: 'circleSlash',
		create: 'circlePlus',
		update: 'pencil',
		move: 'arrowRight',
		delete: 'trash',
		restore: 'rotateCcw',
		rollback: 'rotateCcw'
	};
	assert.deepEqual(TIMELINE_ICON, icons);
	const states = new Set(['status']);
	assert.equal(revisionAction(at({ revision: 1 }), states), 'create');
	assert.equal(revisionAction(at({}), states), 'update');
	assert.equal(revisionAction(at({ fields: ['title', 'status'] }), states), 'move');
	assert.equal(revisionAction(at({ cause: 'erased' }), states), 'delete');
	assert.equal(revisionAction(at({ restored_from: 1 }), states), 'restore');
	assert.equal(
		revisionAction(at({ restored_from: 1, approval: { request: 'r1', state: 'Rejected' } }), states),
		'rollback'
	);
});

it.live('an entry is an icon, one quiet line, its reason quoted and its notes below; a pickable one is a button', () =>
	browser(async () => {
		const target = document.body.appendChild(document.createElement('div'));
		let picked = 0;
		const view = mount(Timeline, {
			target,
			props: {
				label: 'History',
				entries: [
					{
						key: 'a',
						action: 'request_changes',
						line: ['Requested changes', 'Sales rep', '13 Nov, 7:49 pm'],
						quote: 'Attach the receipt',
						data: { 'data-move-key': 'a' }
					},
					{
						key: 'b',
						action: 'update',
						line: ['Updated', 'Ada', '12 Nov'],
						notes: [{ kind: 'fields', text: 'Title, Crew' }],
						mark: { text: 'Current' },
						current: true,
						onpick: () => {
							picked++;
						}
					}
				]
			}
		});
		flushSync();
		const [first, second] = [...target.querySelectorAll<HTMLElement>('li[data-action]')];
		assert.equal(required(first).dataset['moveKey'], 'a');
		assert.equal(required(first).querySelector('svg')?.dataset['icon'], 'messageWarning');
		assert.equal(textOf(required(first).querySelector('[data-line]')), 'Requested changes · Sales rep · 13 Nov, 7:49 pm');
		assert.equal(textOf(required(first).querySelector('[data-reason]')), '“Attach the receipt”');
		assert.equal(required(first).querySelector('button'), null);
		assert.equal(required(second).querySelector('svg')?.dataset['icon'], 'pencil');
		assert.equal(textOf(required(second).querySelector('[data-note=fields]')), 'Title, Crew');
		assert.equal(textOf(required(second).querySelector('[data-mark]')), 'Current');
		const pick = required(required(second).querySelector<HTMLButtonElement>('[data-pick]'));
		assert.equal(pick.getAttribute('aria-current'), 'true');
		pick.click();
		assert.equal(picked, 1);
		await unmount(view);
		target.remove();
	})
);
