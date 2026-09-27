import { describe, expect, it } from 'vitest';
import { compileAuthority } from '../src/engine/access/authority.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';
import { erasableFields, judgeErase } from '../src/engine/identity/erase.ts';

const m = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		payslips: { description: '', label: 'number', key: ['number'], fields: {
			number: { kind: 'text' }, employee_name: { kind: 'text' }, bank: { kind: 'text' }, net: { kind: 'money' }, gross: { kind: 'money' },
			email: { kind: 'text', unique: true }, lines_total: { kind: 'sum', of: 'lines.amount' },
			status: { kind: 'state', initial: 'draft', states: { draft: { to: ['paid'] }, paid: { edit: 'none' } } } },
			check: { positive: { net: { gte: 0 } } }, computed: { label: { kind: 'text', expr: { concat: [{ field: 'number' }] } } } },
		lines: { description: '', label: 'amount', fields: { amount: { kind: 'money' }, memo: { kind: 'text' }, kept: { kind: 'bool' } } },
	},
	relationships: { 'lines.payslip': { to: 'payslips', inverse: 'lines', owned: true } },
	collections: { payslips: { read: { fields: 'all' } }, lines: { read: { fields: 'all' } } },
	integrations: {}, pipelines: {}, policies: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {},
	apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const member = { kind: 'member', id: 'u', email: null, external: false, teams: [], teamPath: [], admin: true, party: null } as const;
const admin = compileAuthority(m, { actor: member, admin: true, policies: [] }, 'a');
const rep = compileAuthority(m, { actor: { ...member, admin: false }, admin: false, policies: [] }, 'r');

describe('engine/identity: erasure admission (rule 38e(d))', () => {
	it('erasable = stored authored fields outside keys, unique, states, relations, checks and roll-ups', () => {
		expect(erasableFields(m, 'payslips').sort()).toEqual(['bank', 'employee_name', 'gross']);
		expect(erasableFields(m, 'lines').sort()).toEqual(['kept', 'memo']);   // `amount` is summed by the parent
	});

	it('remove refuses a locked row; anonymise of a personal field on it commits; naming a fixed field is `locked`', () => {
		const paid = { id: 'p1', status: 'paid', approval_id: null };
		expect(judgeErase(m, admin, 'payslips', [paid], { mode: 'remove' })).toMatchObject({ ok: false, code: 'locked' });
		expect(judgeErase(m, admin, 'payslips', [{ ...paid, status: 'draft' }], { mode: 'remove' })).toEqual({ ok: true });
		expect(judgeErase(m, admin, 'payslips', [paid], { mode: 'anonymise', set: { employee_name: 'Erased' } })).toEqual({ ok: true });
		expect(judgeErase(m, admin, 'payslips', [paid], { mode: 'anonymise', set: { net: '0' } })).toMatchObject({ code: 'locked' });
		expect(judgeErase(m, admin, 'payslips', [paid], { mode: 'anonymise', set: { lines_total: '0' } })).toMatchObject({ code: 'invalidInput' });
	});

	it('admin-only; a held row refuses `approvalHeld` (never routed to approval)', () => {
		expect(judgeErase(m, rep, 'payslips', [{ id: 'p', status: 'draft' }], { mode: 'remove' })).toMatchObject({ code: 'forbidden' });
		expect(judgeErase(m, admin, 'payslips', [{ id: 'p', status: 'draft', approval_id: 'req1' }], { mode: 'remove' }))
			.toMatchObject({ code: 'approvalHeld', requestId: 'req1' });
	});
});
