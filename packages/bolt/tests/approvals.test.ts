import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { IdValue } from '@norbital-ai/std/kind';
import type { Id } from '../src/decl/values.ts';
import { approvalFlow, snapshotOf } from '../src/decl/access/policy.ts';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import {
	canApprove,
	canSupersede,
	participant,
	rolesOf,
	sameFlow,
	type Request
} from '../src/engine/approvals/route.ts';
import { decisionsFor, moveOf, transition } from '../src/engine/approvals/machine.ts';
import { rowApproval } from '../src/engine/approvals/lock.ts';
import { inboxRequests } from '../src/engine/approvals/inbox.ts';
import { authority } from './write-fixture.ts';

const MemberId = Schema.declare((value: unknown): value is Id<'sys_user'> =>
	Schema.is(IdValue)(value)
);

const actor = (id: string, team: string): Extract<EngineActor, { kind: 'member' }> => ({
	kind: 'member',
	id,
	email: null,
	phone: null,
	external: false,
	teams: [team],
	teamPath: [team],
	admin: false,
	party: null
});
const as = (id: string, team: string, admin = false): Authority => ({
	...authority({}, admin),
	actor: actor(id, team)
});
const request: Request = {
	state: 'Pending',
	step: 0,
	requestor: 'member:requester',
	user: 'requester',
	route: {
		kind: 'steps',
		steps: [
			{ name: 'Manager', teams: [], users: ['manager'] },
			{ name: 'Finance', teams: ['finance'], users: [] }
		],
		superseded_by: ['leadership']
	}
};

describe('approval flows', () => {
	it('shows requesters their pending status with only withdraw, without exposing it to strangers', () => {
		const row = {
			id: 'request',
			state: 'Pending',
			model: 'orders',
			record: 'order',
			action: 'update',
			requestor: 'member:requester',
			user: 'requester',
			step: 0,
			route: request.route,
			at: '2026-10-25T00:00:00.000Z',
			by: 'Requester'
		};
		for (const state of ['Pending', 'ChangesRequested']) {
			const rows = [{ ...row, state }];
			expect(inboxRequests(rows, as('requester', 'staff'))).toMatchObject([
				{
					id: 'request',
					mine: true,
					canDecide: false,
					canSupersede: false,
					moves: [{ decision: 'withdraw', reason: 'optional' }]
				}
			]);
			expect(inboxRequests(rows, as('stranger', 'staff'))).toEqual([]);
		}
		expect(inboxRequests([row], as('manager', 'staff'))).toMatchObject([
			{ id: 'request', mine: false, canDecide: true }
		]);
	});
	it('decodes held approval steps and rejects malformed stored metadata', () => {
		const held = {
			requestId: 'request',
			state: request.state,
			step: request.step,
			steps: request.route.steps,
			by: 'Requester'
		};
		expect(rowApproval(held)).toEqual({
			requestId: 'request',
			state: 'Pending',
			step: 0,
			steps: request.route.steps,
			requestedBy: 'Requester'
		});
		expect(rowApproval({ ...held, steps: [] })).toBeUndefined();
		expect(
			rowApproval({ ...held, steps: [{ name: 'Manager', teams: [], users: [42] }] })
		).toBeUndefined();
	});
	it('snapshots conditional named steps and direct allow or deny', () => {
		expect(
			snapshotOf(
				approvalFlow()
					.if(false, (flow) =>
						flow.step('Manager', {
							users: [Schema.decodeUnknownSync(MemberId)('0199a000-0000-7000-8000-000000000002')]
						})
					)
					.else((flow) => flow.step('HR', { teams: ['finance'] }))
					.supersededBy(['sales'])
			)
		).toEqual({
			kind: 'steps',
			steps: [{ name: 'HR', teams: ['finance'], users: [] }],
			superseded_by: ['sales']
		});
		expect(snapshotOf(approvalFlow().allow())).toEqual({ kind: 'allow' });
		expect(snapshotOf(approvalFlow().deny('Not available'))).toEqual({
			kind: 'deny',
			message: 'Not available'
		});
	});
	it('allows the named user or current step team, without inheriting parent authority', () => {
		expect(canApprove(request, as('manager', 'staff'))).toBe(true);
		expect(canApprove(request, as('other', 'finance'))).toBe(false);
		expect(canApprove({ ...request, step: 1 }, as('other', 'finance'))).toBe(true);
		expect(
			canApprove(request, {
				...as('other', 'staff'),
				actor: { ...actor('other', 'staff'), teamPath: ['leadership', 'staff'] }
			})
		).toBe(false);
	});
	it('restricts approval to members and lets an administrator supersede', () => {
		expect(
			canApprove(request, {
				...as('system', 'staff'),
				actor: { kind: 'system', run: 'run', by: { automation: 'job' } }
			})
		).toBe(false);
		expect(canSupersede(request, as('leader', 'leadership'))).toBe(true);
		expect(canSupersede(request, as('admin', 'staff', true))).toBe(true);
	});
	it('excludes the requester even when named, in the reviewing team, or allowed to supersede', () => {
		const mine: Request = {
			...request,
			route: {
				...request.route,
				steps: [{ name: 'Peer review', teams: ['finance'], users: ['requester', 'manager'] }]
			}
		};
		for (const auth of [
			as('requester', 'staff'),
			as('requester', 'finance'),
			as('requester', 'leadership'),
			as('requester', 'staff', true)
		]) {
			expect(canApprove(mine, auth)).toBe(false);
			expect(canSupersede(mine, auth)).toBe(false);
			const roles = rolesOf(mine, auth);
			expect(decisionsFor('Pending', roles)).toEqual([
				{ decision: 'withdraw', reason: 'optional' }
			]);
			expect(transition(mine, 1, moveOf('approve', roles), roles, 'Override')).toMatchObject({
				refused: 'forbidden'
			});
			expect(participant(mine, auth)).toBe(true);
		}
		expect(canApprove(mine, as('manager', 'staff'))).toBe(true);
	});
	it('keeps linked senders and previewing requesters out of review and inbox decisions', () => {
		for (const r of [request, { ...request, requestor: 'envoy:sender' }]) {
			for (const auth of [
				as('requester', 'leadership', true),
				{ ...as('manager', 'staff'), preview: { by: 'requester', team: null } }
			]) {
				expect(canApprove(r, auth)).toBe(false);
				expect(canSupersede(r, auth)).toBe(false);
				// the requester's own identity alone withdraws: never a linked sender's member or a previewer
				expect(decisionsFor('Pending', rolesOf(r, auth))).toEqual(
					r.requestor === 'member:requester' && auth.preview === undefined
						? [{ decision: 'withdraw', reason: 'optional' }]
						: []
				);
			}
		}
		const rows = [
			{
				id: 'request',
				state: 'Pending',
				model: 'orders',
				record: 'order',
				action: 'update',
				requestor: request.requestor,
				user: request.user,
				step: 0,
				route: {
					...request.route,
					steps: [{ name: 'Peers', teams: ['finance'], users: ['requester'] }]
				},
				at: '2026-10-25T00:00:00.000Z',
				by: 'Requester'
			}
		];
		expect(inboxRequests(rows, as('requester', 'finance', true))).toMatchObject([
			{
				mine: true,
				canDecide: false,
				canSupersede: false,
				moves: [{ decision: 'withdraw', reason: 'optional' }]
			}
		]);
	});
	it('uses supersede for a superseder’s approve and requires its reason', () => {
		const roles = rolesOf(request, as('leader', 'leadership'));
		expect(moveOf('approve', roles)).toBe('supersede');
		expect(decisionsFor('Pending', roles)).toEqual([
			{ decision: 'approve', reason: 'required' },
			{ decision: 'reject', reason: 'required' },
			{ decision: 'requestChanges', reason: 'required' }
		]);
		expect(transition(request, 2, 'supersede', roles, '')).toMatchObject({ refused: 'reason' });
	});
	it('advances one step and approves only after the final step', () => {
		const roles = new Set(['approver'] as const);
		expect(transition(request, 2, 'approve', roles, '')).toMatchObject({
			next: { state: 'Pending', step: 1 }
		});
		expect(transition({ state: 'Pending', step: 1 }, 2, 'approve', roles, '')).toMatchObject({
			next: { state: 'Approved', step: 1 }
		});
	});
	it('resubmits only for the requester and resumes or restarts at the engine’s selected step', () => {
		const changed = { ...request, state: 'ChangesRequested' as const, step: 1 };
		expect(
			transition(changed, 2, 'resubmit', rolesOf(changed, as('manager', 'staff')), '')
		).toMatchObject({ refused: 'forbidden' });
		expect(
			transition(changed, 2, 'resubmit', rolesOf(changed, as('requester', 'staff')), '', 1)
		).toMatchObject({ next: { state: 'Pending', step: 1 } });
		expect(
			transition(changed, 2, 'resubmit', rolesOf(changed, as('requester', 'staff')), '', 0)
		).toMatchObject({ next: { state: 'Pending', step: 0 } });
		expect(sameFlow(request.route, { ...request.route, steps: [...request.route.steps] })).toBe(
			true
		);
		expect(sameFlow(request.route, { ...request.route, superseded_by: ['different'] })).toBe(true);
		expect(
			sameFlow(request.route, {
				...request.route,
				steps: [{ name: 'Changed', teams: [], users: ['manager'] }]
			})
		).toBe(false);
	});
	it('rejects terminal moves and requires reasons for rejection or requested changes', () => {
		const roles = new Set(['approver'] as const);
		for (const move of ['reject', 'requestChanges'] as const)
			expect(transition(request, 2, move, roles, '')).toMatchObject({ refused: 'reason' });
		expect(transition({ state: 'Approved', step: 1 }, 2, 'reject', roles, 'No')).toMatchObject({
			refused: 'invalidMove'
		});
		expect(participant({ ...request, state: 'Rejected' }, as('manager', 'staff'))).toBe(false);
	});
	it('withdraws only for the requester, from either open state, with an optional reason and a rollback', () => {
		const mine = rolesOf(request, as('requester', 'staff'));
		for (const state of ['Pending', 'ChangesRequested'] as const)
			expect(transition({ state, step: 1 }, 2, 'withdraw', mine, '')).toMatchObject({
				next: { state: 'Withdrawn', step: 1 },
				edge: { rollback: true }
			});
		for (const auth of [
			as('manager', 'staff'),
			as('leader', 'leadership'),
			as('admin', 'staff', true)
		]) {
			const roles = rolesOf(request, auth);
			expect(decisionsFor('Pending', roles).map((d) => d.decision)).not.toContain('withdraw');
			expect(transition(request, 2, 'withdraw', roles, '')).toMatchObject({
				refused: 'forbidden',
				message: 'Only the requester may withdraw.'
			});
		}
		for (const state of ['Approved', 'Rejected', 'Superseded', 'Withdrawn'] as const)
			expect(transition({ state, step: 0 }, 2, 'withdraw', mine, '')).toMatchObject({
				refused: 'invalidMove'
			});
	});
});
