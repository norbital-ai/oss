// The approval panel (spec §7): a scope selector over a record's requests and a two-step decision form showing exactly
// the host's decisions.
import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { ApprovalView, Outcome } from '../src/client/contract.ts';
import { element } from './elements.ts';
import { browser, required, textOf, viewFixture } from './view-fixture.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: ApprovalPanel } = await import('../src/approval/ApprovalPanel.svelte');
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
type Entry = ApprovalView['log'][number];
const entry = (
	move: Entry['move'],
	who: string,
	at: string,
	extra: Partial<Entry> = {}
): Entry => ({
	move,
	by: by(who),
	at,
	from: move === 'request' ? null : 'Pending',
	to: 'Pending',
	step: 0,
	reason: null,
	...extra
});
const steps = [
	{ name: 'Controllers', teams: ['field_ops_controllers'], users: [] },
	{ name: 'Commercial', teams: ['commercial'], users: [] }
];
const request: ApprovalView = {
	id: 'r1',
	model: 'jobs',
	record: 'j1',
	action: 'update',
	at: '2026-10-13T12:00:00Z',
	status: 'Pending',
	step: 0,
	steps,
	superseded_by: [],
	teamNames: { field_ops_controllers: 'Controllers', commercial: 'Commercial' },
	userNames: {},
	requestor: by('Bob'),
	log: [entry('request', 'Bob', '2026-10-13T12:00:00Z')],
	records: [{ model: 'jobs', id: 'j1', op: 'update' }],
	moves: [],
	mine: false,
	participant: true
};
const panel = (
	requests: readonly ApprovalView[],
	act?: (callable: string, input: unknown) => void
) =>
	Effect.gen(function* () {
		const outcomes: Outcome[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
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
				view: ApprovalPanel,
				props: { requests, onOutcome: (o: Outcome) => outcomes.push(o) }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		return { target, outcomes };
	});
const nodes = (target: ParentNode) => [
	...target.querySelectorAll<HTMLElement>('[data-view=approval-timeline] > li')
];
const node = (target: ParentNode, step: string) =>
	element<HTMLButtonElement>(target, `[data-step="${step}"] button`);
const popover = () => element<HTMLElement>(document, '[data-view=approval-step-log]');
const decisions = (target: ParentNode) => [
	...target.querySelectorAll<HTMLButtonElement>('[data-view=approval-controls] button')
];

it.live(
	"a node's popover holds its step's back-and-forth, opened by a tap or by keyboard focus",
	() =>
		Effect.gen(function* () {
			const { target } = yield* panel([
				{
					...request,
					status: 'Rejected',
					log: [
						...request.log,
						entry('requestChanges', 'Sam', '2026-10-14T12:00:00Z', {
							to: 'ChangesRequested',
							reason: 'Add the quote'
						}),
						entry('resubmit', 'Bob', '2026-10-15T12:00:00Z', {
							from: 'ChangesRequested',
							changed: ['title', 'crew']
						}),
						entry('reject', 'Sam', '2026-10-16T12:00:00Z', {
							to: 'Rejected',
							reason: 'Too costly',
							rolledBack: [{ model: 'jobs', id: 'j1', action: 'restored' }],
							skipped: [{ model: 'jobs', id: 'j1', field: 'customer', reason: 'deletedTarget' }]
						})
					]
				}
			]);
			assert.deepEqual(
				nodes(target).map((li) => li.dataset['look']),
				['done', 'rejected', 'later']
			);
			assert.match(textOf(nodes(target)[1]?.querySelector('[data-caption]')), /^Sam · /);
			node(target, 'step-0').click();
			yield* browser(() => settle());
			const log = popover();
			assert.deepEqual(
				[...log.querySelectorAll<HTMLElement>('[data-move]')].map((li) => li.dataset['move']),
				['requestChanges', 'resubmit', 'reject']
			);
			assert.deepEqual([...log.querySelectorAll('[data-reason]')].map(textOf), [
				'“Add the quote”',
				'“Too costly”'
			]);
			assert.equal(textOf(element(log, '[data-changed]')).trim(), 'Changed: Title, Crew');
			assert.match(textOf(element(log, '[data-rolled-back]')), /Rolled back: Jobs restored/);
			assert.match(textOf(element(log, '[data-skipped]')), /The linked record was deleted/);
			// a closed request has no form
			assert.equal(target.querySelector('[data-view=approval-controls]'), null);

			// keyboard focus opens the request node's own popover in place of the step's
			const first = node(target, 'request');
			yield* browser(async () => {
				first.focus();
				await settle();
			});
			assert.deepEqual(
				[...popover().querySelectorAll<HTMLElement>('[data-move]')].map((li) => li.dataset['move']),
				['request']
			);
		})
);

it.live(
	'the form shows exactly the host decisions; reject and request changes ask for a reason',
	() =>
		Effect.gen(function* () {
			const sent: { callable: string; input: unknown }[] = [];
			const { target, outcomes } = yield* panel(
				[
					{
						...request,
						moves: [
							{ decision: 'requestChanges', reason: 'required' },
							{ decision: 'approve', reason: 'optional' },
							{ decision: 'reject', reason: 'required' }
						]
					}
				],
				(callable, input) => sent.push({ callable, input })
			);
			assert.deepEqual(
				decisions(target).map((b) => textOf(b).trim()),
				['Approve', 'Reject', 'Request changes']
			);
			required(decisions(target).find((b) => b.dataset['decision'] === 'requestChanges')).click();
			yield* browser(() => settle());
			const form = element<HTMLFormElement>(target, '[data-view=approval-controls] form');
			const reason = element<HTMLTextAreaElement>(form, 'textarea');
			assert.equal(element<HTMLLabelElement>(form, 'label').htmlFor, reason.id);
			assert.equal(textOf(element(form, 'label')).trim(), 'Request changes · reason (required)');
			const confirm = element<HTMLButtonElement>(form, '[data-confirm]');
			assert.equal(textOf(confirm).trim(), 'Request changes', 'the confirm repeats the action');
			assert.equal(confirm.disabled, true);
			// Back returns to the three decisions
			element<HTMLButtonElement>(form, '[data-back]').click();
			yield* browser(() => settle());
			assert.equal(decisions(target).length, 3);
			required(decisions(target).find((b) => b.dataset['decision'] === 'requestChanges')).click();
			yield* browser(() => settle());
			const note = element<HTMLTextAreaElement>(target, '[data-view=approval-controls] textarea');
			note.value = 'Add the quote';
			note.dispatchEvent(new Event('input', { bubbles: true }));
			yield* browser(() => settle());
			const send = element<HTMLButtonElement>(target, '[data-confirm]');
			assert.equal(send.disabled, false);
			send.click();
			yield* browser(() => settle());
			assert.deepEqual(sent, [
				{
					callable: 'approvals.decide',
					input: { requestId: 'r1', decision: 'requestChanges', reason: 'Add the quote' }
				}
			]);
			assert.equal(outcomes.length, 1);
			assert.equal(target.querySelector('[data-view=approval-controls] form'), null);
		})
);

it.live('approve takes an optional reason; a superseder sees the same three decisions', () =>
	Effect.gen(function* () {
		const sent: unknown[] = [];
		const { target } = yield* panel(
			[
				{
					...request,
					moves: [
						{ decision: 'approve', reason: 'optional' },
						{ decision: 'reject', reason: 'required' },
						{ decision: 'requestChanges', reason: 'required' }
					]
				}
			],
			(_callable, input) => sent.push(input)
		);
		required(decisions(target)[0]).click();
		yield* browser(() => settle());
		const form = element<HTMLFormElement>(target, '[data-view=approval-controls] form');
		assert.equal(textOf(element(form, 'label')).trim(), 'Approve · reason (optional)');
		const confirm = element<HTMLButtonElement>(form, '[data-confirm]');
		assert.equal(confirm.disabled, false);
		confirm.click();
		yield* browser(() => settle());
		assert.deepEqual(sent, [{ requestId: 'r1', decision: 'approve' }]);

		// a superseder: the host requires the reason for their approve
		const superseder = yield* panel([
			{
				...request,
				moves: [
					{ decision: 'approve', reason: 'required' },
					{ decision: 'reject', reason: 'required' },
					{ decision: 'requestChanges', reason: 'required' }
				]
			}
		]);
		assert.deepEqual(
			decisions(superseder.target).map((b) => textOf(b).trim()),
			['Approve', 'Reject', 'Request changes']
		);
		required(decisions(superseder.target)[0]).click();
		yield* browser(() => settle());
		assert.equal(
			element<HTMLButtonElement>(superseder.target, '[data-confirm]').disabled,
			true,
			'a superseding approve waits for its reason'
		);
	})
);

it.live('the requester of a request that asks for changes is told that saving resubmits', () =>
	Effect.gen(function* () {
		const { target } = yield* panel([
			{
				...request,
				status: 'ChangesRequested',
				mine: true,
				log: [
					...request.log,
					entry('requestChanges', 'Sam', '2026-10-14T12:00:00Z', {
						to: 'ChangesRequested',
						reason: 'Add the quote'
					})
				]
			}
		]);
		assert.equal(
			textOf(element(target, '[data-view=approval-resubmit]')).trim(),
			'Saving resubmits for approval'
		);
		assert.equal(nodes(target)[1]?.dataset['look'], 'changes');
		assert.equal(target.querySelector('[data-view=approval-controls]'), null, 'no Resubmit button');
	})
);

it.live('several requests: the selector defaults to the open one and switches the timeline', () =>
	Effect.gen(function* () {
		const old: ApprovalView = {
			...request,
			id: 'r0',
			at: '2026-09-01T12:00:00Z',
			status: 'Rejected',
			log: [
				entry('request', 'Bob', '2026-09-01T12:00:00Z'),
				entry('reject', 'Sam', '2026-09-02T12:00:00Z', { to: 'Rejected', reason: 'No' })
			]
		};
		const { target } = yield* panel([old, request]);
		const scope = element<HTMLSelectElement>(target, '[data-view=approval-scope]');
		assert.equal(scope.value, 'r1');
		assert.equal(
			element<HTMLLabelElement>(target, `label[for="${scope.id}"]`).textContent,
			'Request'
		);
		assert.deepEqual(
			[...scope.options].map((o) => [o.value, /^#\d · \w[\w ]* · /.test(textOf(o))]),
			[
				['r1', true],
				['r0', true]
			]
		);
		assert.match(textOf(required(scope.options[0])), /^#2 · Pending · /);
		assert.match(textOf(required(scope.options[1])), /^#1 · Rejected · /);
		assert.equal(nodes(target)[1]?.dataset['look'], 'active');
		scope.value = 'r0';
		scope.dispatchEvent(new Event('change', { bubbles: true }));
		yield* browser(() => settle());
		assert.equal(element(target, '[data-view=approval]').dataset['status'], 'Rejected');
		assert.equal(nodes(target)[1]?.dataset['look'], 'rejected');
	})
);
