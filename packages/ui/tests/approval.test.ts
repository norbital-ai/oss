// The approval panel renders the host's full log and exactly the host's moves; lists accent the rows a request holds.
import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { ApprovalView, Outcome } from '../src/client/contract.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Values } from '../src/collection/types.ts';
import { element } from './elements.ts';
import { browser, required, textOf, viewFixture } from './view-fixture.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const settle = async () => {
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	document.body.replaceChildren();
});
const by = (name: string) => ({ ref: `member:${name}`, name });
const request: ApprovalView = {
	id: 'r1',
	collection: 'jobs',
	record: 'j1',
	action: 'update',
	at: '2026-10-13T00:00:00Z',
	status: 'ONGOING',
	step: 0,
	steps: [['reviewers']],
	superseded_by: [],
	teamNames: { reviewers: 'Review team' },
	requestor: by('Ada'),
	log: [
		{
			move: 'request',
			by: by('Ada'),
			at: '2026-10-13T00:00:00Z',
			from: null,
			to: 'ONGOING',
			step: 0,
			reason: null
		},
		{
			move: 'comment',
			by: by('Sam'),
			at: '2026-10-13T01:00:00Z',
			from: 'ONGOING',
			to: 'ONGOING',
			step: 0,
			reason: 'Which supplier?'
		},
		{
			move: 'requestChanges',
			by: by('Sam'),
			at: '2026-10-13T02:00:00Z',
			from: 'ONGOING',
			to: 'CHANGES_REQUESTED',
			step: 0,
			reason: 'Add the quote'
		},
		{
			move: 'resubmit',
			by: by('Ada'),
			at: '2026-10-13T03:00:00Z',
			from: 'CHANGES_REQUESTED',
			to: 'ONGOING',
			step: 0,
			reason: 'Quote added'
		}
	],
	records: [
		{ collection: 'jobs', id: 'j1', op: 'update' },
		{ collection: 'lines', id: 'l1', op: 'create' }
	],
	moves: [],
	mine: false,
	participant: true
};
const panel = (view: ApprovalView, act?: (callable: string, input: unknown) => void) =>
	Effect.gen(function* () {
		const outcomes: Outcome[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				approval: () => view,
				act: (callable, input) => {
					act?.(callable, input);
					return { kind: 'committed', output: null, records: [] };
				}
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: {},
				part: 'approval',
				props: { requestId: 'r1', onOutcome: (o: Outcome) => outcomes.push(o) }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		return { target, outcomes };
	});
const buttons = (target: ParentNode) => [
	...target.querySelectorAll<HTMLButtonElement>('[data-view=approval-controls] button')
];

it.live('the timeline shows every transition and comment, with reasons and rollback results', () =>
	Effect.gen(function* () {
		const { target } = yield* panel({
			...request,
			status: 'REJECTED',
			log: [
				...request.log,
				{
					move: 'reject',
					by: by('Sam'),
					at: '2026-10-13T04:00:00Z',
					from: 'ONGOING',
					to: 'REJECTED',
					step: 0,
					reason: 'Too costly',
					rolledBack: [
						{ collection: 'jobs', id: 'j1', action: 'restored' },
						{ collection: 'lines', id: 'l1', action: 'removed' }
					],
					skipped: [{ collection: 'jobs', id: 'j1', field: 'customer', reason: 'deletedTarget' }]
				}
			]
		});
		const entries = [...target.querySelectorAll<HTMLElement>('[data-view=approval-timeline] li')];
		assert.deepEqual(
			entries.map((li) => li.dataset['move']),
			['request', 'comment', 'requestChanges', 'resubmit', 'reject']
		);
		assert.deepEqual([...target.querySelectorAll('[data-reason]')].map(textOf), [
			'“Which supplier?”',
			'“Add the quote”',
			'“Quote added”',
			'“Too costly”'
		]);
		assert.match(textOf(element<HTMLElement>(target, '[data-rolled-back]')), /restored.*removed/);
		assert.match(
			textOf(element<HTMLElement>(target, '[data-skipped]')),
			/The linked record was deleted/
		);
		assert.equal(target.querySelector('[data-view=approval-controls]'), null);
		assert.match(
			textOf(element<HTMLElement>(target, '[data-view=approval-summary]')),
			/Rejected.*Too costly/s
		);
		assert.equal(element<HTMLDetailsElement>(target, '[data-view=approval-history]').open, false);
	})
);

it.live('the buttons are exactly the host moves; a required reason gates its move', () =>
	Effect.gen(function* () {
		const sent: { callable: string; input: unknown }[] = [];
		const { target, outcomes } = yield* panel(
			{
				...request,
				moves: [
					{ status: 'APPROVED', reason: 'optional' },
					{ status: 'REQUEST_FOR_CHANGE', reason: 'required' },
					{ status: 'COMMENT', reason: 'required' }
				]
			},
			(callable, input) => sent.push({ callable, input })
		);
		assert.deepEqual(
			buttons(target).map((b) => b.dataset['move']),
			['APPROVED', 'REQUEST_FOR_CHANGE', 'COMMENT']
		);
		const change = required(
			buttons(target).find((b) => b.dataset['move'] === 'REQUEST_FOR_CHANGE')
		);
		assert.equal(change.disabled, true);
		const input = element<HTMLTextAreaElement>(target, '[data-view=approval-controls] textarea');
		assert.equal(
			element<HTMLLabelElement>(target, '[data-view=approval-controls] label').htmlFor,
			input.id
		);
		input.value = 'Add the quote';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() => settle());
		assert.equal(change.disabled, false);
		change.click();
		yield* browser(() => settle());
		assert.deepEqual(sent, [
			{
				callable: 'approvals.process',
				input: { requestId: 'r1', status: 'REQUEST_FOR_CHANGE', reason: 'Add the quote' }
			}
		]);
		assert.equal(outcomes.length, 1);
		// a requester in ChangesRequested sees only their own moves
		const mine = yield* panel({
			...request,
			status: 'CHANGES_REQUESTED',
			mine: true,
			moves: [
				{ status: 'REJECTED', reason: 'optional' },
				{ status: 'RESUBMITTED', reason: 'optional' },
				{ status: 'WITHDRAWN', reason: 'optional' }
			]
		});
		assert.deepEqual(
			buttons(mine.target).map((b) => textOf(b)),
			['Resubmit', 'Reject', 'Withdraw']
		);
		assert.match(textOf(element<HTMLElement>(mine.target, '[data-view=approval-waiting]')), /Ada/);
	})
);

it.live(
	'an RFC surfaces its decision reason ahead of controls and keeps later comments in history',
	() =>
		Effect.gen(function* () {
			const { target } = yield* panel({
				...request,
				status: 'CHANGES_REQUESTED',
				mine: true,
				log: [
					...request.log.slice(0, 3),
					{
						move: 'comment',
						by: by('Ada'),
						at: '2026-10-13T03:00:00Z',
						from: 'CHANGES_REQUESTED',
						to: 'CHANGES_REQUESTED',
						step: 0,
						reason: 'I will add it tomorrow.'
					}
				],
				moves: [{ status: 'RESUBMITTED', reason: 'optional' }]
			});
			const summary = element<HTMLElement>(target, '[data-view=approval-summary]');
			assert.match(
				textOf(summary),
				/Changes requested.*Awaiting changes from.*Ada.*Add the quote/s
			);
			assert.doesNotMatch(textOf(summary), /I will add it tomorrow/);
			assert.ok(
				summary.compareDocumentPosition(element(target, '[data-view=approval-controls]')) &
					Node.DOCUMENT_POSITION_FOLLOWING
			);
			assert.match(
				textOf(element(target, '[data-view=approval-timeline]')),
				/I will add it tomorrow/
			);
		})
);

const held = {
	requestId: 'r1',
	state: 'Pending',
	step: 0,
	steps: 2,
	requestedBy: 'Ada',
	waitingOn: ['Finance']
};
const tip = 'Requested by Ada · Pending step 1/2 · waiting on Finance';
const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' }, status: { kind: 'enum', values: ['todo', 'done'] } }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const listed: readonly Values[] = [
	{ id: 'a', title: 'Held', status: 'todo', $approval: held },
	{ id: 'b', title: 'Free', status: 'todo' }
];
const lists = (part: 'table' | 'board') =>
	Effect.gen(function* () {
		const { bolt } = yield* browser(() =>
			viewFixture({
				read: () => ({ rows: listed, next: null }),
				aggregate: () => [{ key: { status: 'todo' }, count: 2 }]
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props:
				part === 'table'
					? { bolt, catalog, part, props: { of: 'jobs', columns: ['title'] } }
					: {
							bolt,
							catalog,
							part,
							props: {
								of: 'jobs',
								by: 'status',
								card: ['title'],
								toolbar: { title: false, search: false, filter: false, export: false, new: false }
							}
						}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		return target;
	});

it.live('a table row the request holds carries the right-hand accent and its tooltip', () =>
	Effect.gen(function* () {
		const target = yield* lists('table');
		const rows = [...target.querySelectorAll<HTMLTableRowElement>('tbody tr[data-approval]')];
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.dataset['approval'], 'Pending');
		assert.equal(rows[0]?.title, tip);
		assert.match(textOf(required(rows[0])), /Held/);
		const narrow = [...target.querySelectorAll<HTMLElement>('[data-table-list] [data-approval]')];
		assert.deepEqual(
			narrow.map((s) => s.title),
			[tip]
		);
	})
);

it.live('a board card the request holds carries the accent and its tooltip', () =>
	Effect.gen(function* () {
		const target = yield* lists('board');
		const heldCard = element<HTMLElement>(target, '[data-board-card="a"]');
		assert.equal(heldCard.title, tip);
		assert.equal(element<HTMLElement>(heldCard, '[data-approval]').getAttribute('aria-label'), tip);
		assert.equal(
			element<HTMLElement>(target, '[data-board-card="b"]').querySelector('[data-approval]'),
			null
		);
	})
);
