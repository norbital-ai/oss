import { single_act } from './act-envelope.ts';
// The approval panel: a scope selector over a record's requests and a two-step decision form showing exactly
// the host's decisions.
import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { ApprovalView, Outcome } from '../src/client/contract.ts';
import { element } from './elements.ts';
import { browser, required, textOf, viewFixture, type ViewScript } from './view-fixture.ts';

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
	label: null,
	at: '2026-10-13T12:00:00Z',
	status: 'Pending',
	step: 0,
	steps,
	superseded_by: [],
	team_names: { field_ops_controllers: 'Controllers', commercial: 'Commercial' },
	user_names: {},
	requestor: by('Bob'),
	log: [entry('request', 'Bob', '2026-10-13T12:00:00Z')],
	records: [{ model: 'jobs', id: 'j1', op: 'update' }],
	moves: [],
	mine: false,
	participant: true
};
const panel = (
	requests: readonly ApprovalView[],
	act?: (callable: string, input: unknown) => void,
	reply: ViewScript['act'] = () => ({ kind: 'committed', output: null, records: [] })
) =>
	Effect.gen(function* () {
		const outcomes: Outcome[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				act: (body, key) => {
					const { callable, input } = single_act(body);
					act?.(callable, input);
					return reply(body, key);
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
				props: { requests, on_outcome: (o: Outcome) => outcomes.push(o) }
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
						entry('request_changes', 'Sam', '2026-10-14T12:00:00Z', {
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
							rolled_back: [{ model: 'jobs', id: 'j1', action: 'restored' }],
							skipped: [{ model: 'jobs', id: 'j1', field: 'customer', reason: 'deleted_target' }]
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
				[...log.querySelectorAll<HTMLElement>('[data-action]')].map((li) => li.dataset['action']),
				['request_changes', 'resubmit', 'reject']
			);
			assert.deepEqual([...log.querySelectorAll('[data-reason]')].map(textOf), [
				'“Add the quote”',
				'“Too costly”'
			]);
			assert.equal(textOf(element(log, '[data-note=changed]')).trim(), 'Changed: Title, Crew');
			assert.match(textOf(element(log, '[data-note=rolled-back]')), /Rolled back: Jobs restored/);
			assert.match(textOf(element(log, '[data-note=skipped]')), /The linked record was deleted/);
			// a closed request has no form
			assert.equal(target.querySelector('[data-view=approval-controls]'), null);

			// keyboard focus opens the request node's own popover in place of the step's
			const first = node(target, 'request');
			yield* browser(async () => {
				first.focus();
				await settle();
			});
			assert.deepEqual(
				[...popover().querySelectorAll<HTMLElement>('[data-action]')].map((li) => li.dataset['action']),
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
							{ decision: 'request_changes', reason: 'required' },
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
			required(decisions(target).find((b) => b.dataset['decision'] === 'request_changes')).click();
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
			required(decisions(target).find((b) => b.dataset['decision'] === 'request_changes')).click();
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
					input: { request_id: 'r1', decision: 'request_changes', reason: 'Add the quote' }
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
						{ decision: 'request_changes', reason: 'required' }
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
		assert.deepEqual(sent, [{ request_id: 'r1', decision: 'approve' }]);

		// a superseder: the host requires the reason for their approve
		const superseder = yield* panel([
			{
				...request,
				moves: [
					{ decision: 'approve', reason: 'required' },
					{ decision: 'reject', reason: 'required' },
					{ decision: 'request_changes', reason: 'required' }
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

it.live(
	'the requester withdraws with an optional reason; a withdrawn request never reads as rejected',
	() =>
		Effect.gen(function* () {
			const sent: unknown[] = [];
			const { target } = yield* panel(
				[{ ...request, mine: true, moves: [{ decision: 'withdraw', reason: 'optional' }] }],
				(_callable, input) => sent.push(input)
			);
			assert.deepEqual(
				decisions(target).map((b) => textOf(b).trim()),
				['Withdraw']
			);
			required(decisions(target)[0]).click();
			yield* browser(() => settle());
			const confirm = element<HTMLButtonElement>(target, '[data-confirm]');
			assert.equal(confirm.disabled, false);
			confirm.click();
			yield* browser(() => settle());
			assert.deepEqual(sent, [{ request_id: 'r1', decision: 'withdraw' }]);

			const closed = yield* panel([
				{
					...request,
					status: 'Withdrawn',
					mine: true,
					log: [
						...request.log,
						entry('withdraw', 'Bob', '2026-10-14T12:00:00Z', { to: 'Withdrawn' })
					]
				}
			]);
			assert.equal(element(closed.target, '[data-view=approval]').dataset['status'], 'Withdrawn');
			assert.equal(nodes(closed.target)[1]?.dataset['look'], 'withdrawn');
			assert.equal(closed.target.querySelector('[data-view=approval-controls]'), null);
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
					entry('request_changes', 'Sam', '2026-10-14T12:00:00Z', {
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
it.live('a decided request reads as the last entry of its history, its reason once, no closing repeat', () =>
	Effect.gen(function* () {
		const asked: ApprovalView = {
			...request,
			status: 'ChangesRequested',
			mine: true,
			log: [
				entry('request', 'Bob', '2026-10-13T12:00:00Z'),
				entry('request_changes', 'Sam', '2026-10-14T12:00:00Z', {
					to: 'ChangesRequested',
					reason: 'Attach the receipt'
				})
			]
		};
		const changes = yield* panel([asked]);
		const history = element<HTMLElement>(changes.target, '[data-view=approval-history]');
		const last = required([...history.querySelectorAll<HTMLElement>('[data-action]')].at(-1));
		assert.equal(last.dataset['action'], 'request_changes');
		assert.match(textOf(element(last, '[data-line]')), /^Requested changes · Sam · /);
		assert.deepEqual([...changes.target.querySelectorAll('[data-reason]')].map(textOf), ['“Attach the receipt”']);
		assert.equal(changes.target.querySelector('[data-view=approval-outcome]'), null);
		assert.doesNotMatch(textOf(changes.target), /Changes requested · Sam/);
		const withdrawn = yield* panel([
			{
				...request,
				id: 'r2',
				status: 'Withdrawn',
				log: [
					entry('request', 'Bob', '2026-10-13T12:00:00Z'),
					entry('withdraw', 'Bob', '2026-10-14T12:00:00Z', { to: 'Withdrawn' })
				]
			}
		]);
		assert.match(
			textOf(element<HTMLElement>(withdrawn.target, '[data-view=approval-history] [data-action=withdraw] [data-line]')),
			/^Withdrew · Bob · /
		);
		// the withdrawn step is not shown as done by the requester
		assert.match(
			textOf(nodes(withdrawn.target)[1]?.querySelector('[data-caption]')),
			/^Withdrawn by Bob · /
		);
		const pending = yield* panel([request]);
		assert.equal(pending.target.querySelector('[data-view=approval-outcome]'), null);
	})
);
it('a row approval decodes once; a malformed `$approval` is no approval', async () => {
	const { approvalOf, resubmits } = await import('../src/approval/row.ts');
	const $approval = {
		request_id: 'r1',
		state: 'ChangesRequested',
		step: 0,
		steps: [{ name: 'Review', teams: ['ops'], users: [] }],
		requested_by: 'ada'
	};
	assert.deepEqual(approvalOf({ id: 'x', $approval }), $approval);
	assert.equal(resubmits({ $approval }), true);
	assert.equal(approvalOf({ $approval: { ...$approval, state: 'Approved' } }), null);
	assert.equal(approvalOf({ $approval: { ...$approval, steps: [{ name: 'Review' }] } }), null);
	assert.equal(approvalOf(null), null);
});

it.live('a failed decision says why in the pane and leaves the request decidable', () =>
	Effect.gen(function* () {
		const busy = 'This workspace is busy. Please try again shortly.';
		const sent: unknown[] = [];
		const { target, outcomes } = yield* panel(
			[{ ...request, moves: [{ decision: 'reject', reason: 'required' }] }],
			(_callable, input) => sent.push(input),
			() => ({ kind: 'refused', code: 'rate_limited', message: busy })
		);
		required(decisions(target)[0]).click();
		yield* browser(() => settle());
		const note = element<HTMLTextAreaElement>(target, '[data-view=approval-controls] textarea');
		note.value = 'Too costly';
		note.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() => settle());
		element<HTMLButtonElement>(target, '[data-confirm]').click();
		yield* browser(() => settle());
		assert.equal(sent.length, 1);
		assert.equal(outcomes[0]?.kind, 'refused');
		const notice = element<HTMLElement>(target, '[data-view=approval-notice]');
		assert.equal(notice.getAttribute('role'), 'alert');
		assert.equal(textOf(notice).trim(), busy);
		// the form, its reason and its confirm stay: trying again is one click
		const form = element<HTMLFormElement>(target, '[data-view=approval-controls] form');
		assert.equal(element<HTMLTextAreaElement>(form, 'textarea').value, 'Too costly');
		assert.equal(element<HTMLButtonElement>(form, '[data-confirm]').disabled, false);
	})
);

it.live('a resubmitted request keeps its earlier rounds in the pane: changes asked and why, then resubmitted', () =>
	Effect.gen(function* () {
		const { target } = yield* panel([
			{
				...request,
				log: [
					...request.log,
					entry('request_changes', 'Sam', '2026-10-14T12:00:00Z', {
						to: 'ChangesRequested',
						reason: 'Add the quote'
					}),
					entry('resubmit', 'Bob', '2026-10-15T12:00:00Z', {
						from: 'ChangesRequested',
						changed: ['title']
					})
				]
			}
		]);
		const history = element<HTMLElement>(target, '[data-view=approval-history]');
		assert.deepEqual(
			[...history.querySelectorAll<HTMLElement>('[data-action]')].map((li) => li.dataset['action']),
			['request', 'request_changes', 'resubmit']
		);
		assert.match(
			textOf(history),
			/Requested changes · Sam.*“Add the quote”.*Resubmitted · Bob.*Changed: Title/s
		);
	})
);
