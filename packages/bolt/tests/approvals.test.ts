// engine/approvals routing and eligibility, pure (rules 44, 46): one guarantee per test.
import { describe, expect, it } from 'vitest';
import type { ApprovalRoute, Authority, EngineActor } from '../src/engine/contracts.ts';
import { canApprove, canSupersede, participant, resolve, type Request, type RouteRow } from '../src/engine/approvals/route.ts';
import { authority, manifest, member as anyMember, NOW, TODAY } from './write-fixture.ts';

const member = anyMember as Extract<EngineActor, { kind: 'member' }>;

const b = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
const as = (teamPath: string[], admin = false): Authority => ({ ...authority({}, admin), actor: { ...member, teamPath, admin } });
const create = (values: Record<string, string>, routes: readonly ApprovalRoute[]): RouteRow & { routes: readonly ApprovalRoute[] } =>
	({ op: 'create', pre: null, post: values, changed: Object.keys(values), routes });
const FIN: ApprovalRoute = { match: { record: { title: { eq: 'big' } } }, steps: [['Finance']] };
const LEAD: ApprovalRoute = { steps: [['Leadership']], superceded_by: ['Leadership'] };

describe('approvals/route (rule 44)', () => {
	it('the first matching route wins; no match commits directly', () => {
		expect(resolve(manifest, 'orders', b, as(['Sales']), [create({ title: 'big' }, [FIN, LEAD])])).toEqual({ steps: [['Finance']], superceded_by: [] });
		expect(resolve(manifest, 'orders', b, as(['Sales']), [create({ title: 'small' }, [FIN])])).toBeNull();
	});

	it('a changed-fields route routes an update that changes the field, not one that does not', () => {
		const r: ApprovalRoute = { match: { changed: ['note'], previous: { note: { isNull: true } } }, steps: [['Finance']] };
		const row = (changed: string[]) => ({ op: 'update' as const, pre: { title: 'a', note: null }, post: { title: 'a', note: 'x' }, changed, routes: [r] });
		expect(resolve(manifest, 'orders', b, as(['Sales']), [row(['note'])])).not.toBeNull();
		expect(resolve(manifest, 'orders', b, as(['Sales']), [row(['title'])])).toBeNull();
	});

	it('an unrouted row rides the batch route; two different routes split', () => {
		expect(resolve(manifest, 'orders', b, as(['Sales']), [create({ title: 'small' }, [FIN]), create({ title: 'big' }, [FIN])])).toEqual({ steps: [['Finance']], superceded_by: [] });
		expect(resolve(manifest, 'orders', b, as(['Sales']), [create({ title: 'big' }, [FIN]), create({ title: 'x' }, [LEAD])])).toBe('split');
	});

	it('requestor matches on teamPath[0]; no_team is a teamless caller', () => {
		const r = (requestor: unknown): ApprovalRoute[] => [{ match: { requestor }, steps: [['Finance']] }];
		expect(resolve(manifest, 'orders', b, as(['Sales']), [create({ title: 'a' }, r('in_team'))])).not.toBeNull();
		expect(resolve(manifest, 'orders', b, as([]), [create({ title: 'a' }, r('no_team'))])).not.toBeNull();
		expect(resolve(manifest, 'orders', b, as(['Sales', 'Finance']), [create({ title: 'a' }, r({ team: ['finance'] }))])).toBeNull();
	});
});

describe('approvals eligibility (rule 46)', () => {
	const req: Request = { state: 'Pending', step: 0, requestor: `member:${member.id}`, route: { steps: [['Finance'], ['Leadership']], superceded_by: ['Leadership'] } };
	const system: EngineActor = { kind: 'system', run: 'r', by: { automation: 'a' } };

	it('approve needs teamPath[0] on the current step, case-insensitively; a parent team does not inherit', () => {
		expect(canApprove(req, as(['finance']).actor)).toBe(true);
		expect(canApprove(req, as(['Finance Juniors', 'Finance']).actor)).toBe(false);
		expect(canApprove(req, as(['Leadership']).actor)).toBe(false);
	});

	it('static identities have no team and cannot decide', () => {
		expect(canApprove(req, system)).toBe(false);
		expect(canSupersede(req, { ...as([]), actor: system })).toBe(false);
	});

	it('superseders are a superceded_by team or an administrator; participants add the requestor, only while pending', () => {
		expect(canSupersede(req, as(['Leadership']))).toBe(true);
		expect(canSupersede(req, as([], true))).toBe(true);
		expect(participant(req, as([]))).toBe(true);
		expect(participant({ ...req, requestor: 'member:other' }, as(['Ops']))).toBe(false);
		expect(participant({ ...req, state: 'Approved' }, as(['Finance']))).toBe(false);
	});
});
