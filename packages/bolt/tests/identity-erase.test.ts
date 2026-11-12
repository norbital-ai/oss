import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { compile_authority } from '../src/engine/access/authority.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { erasableFields, judgeErase } from '../src/engine/identity/erase.ts';

const m: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		payslips: {
			description: '',
			record_label: 'record.number',
			key: ['number'],
			unique: [{ fields: ['email'], name: 'email' }],
			locks: { paid: { where: { status: { eq: 'paid' } } } },
			fields: {
				number: { kind: 'text' },
				employee_name: { kind: 'text' },
				bank: { kind: 'text' },
				net: { kind: 'money' },
				gross: { kind: 'money' },
				email: { kind: 'text' },
				lines_total: { kind: 'sum', of: 'lines.amount' },
				status: {
					kind: 'state',
					initial: 'draft',
					states: { draft: { to: ['paid'] }, paid: {} }
				}
			},
			check: { positive: { net: { gte: 0 } } },
			computed: { label: { kind: 'text', expr: { concat: [{ field: 'number' }] } } }
		},
		lines: {
			description: '',
			record_label: 'record.amount',
			fields: { amount: { kind: 'money' }, memo: { kind: 'text' }, kept: { kind: 'bool' } }
		}
	},
	relationships: { 'lines.payslip': { to: 'payslips', inverse: 'lines', owned: true } },
	exposures: {
		payslips: { outputs: { default: { payslips: { fields: 'all' } } } },
		lines: { outputs: { default: { lines: { fields: 'all' } } } }
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const member = {
	kind: 'member',
	id: 'u',
	email: null,
	phone: null,
	external: false,
	teams: [],
	team_path: [],
	admin: true,
	party: null
} as const;
const admin = Effect.runSync(compile_authority(m, { actor: member, admin: true, policies: [] }, 'a'));
const rep = Effect.runSync(compile_authority(
	m,
	{ actor: { ...member, admin: false }, admin: false, policies: [] },
	'r'
));
const bindings = { now: '2026-01-01T00:00:00.000Z', today: '2026-01-01', tz: 'UTC' };

describe('engine/identity: erasure admission', () => {
	it('erasable = stored authored fields outside keys, unique, states, relations, checks and roll-ups', () => {
		expect(erasableFields(m, 'payslips').sort()).toEqual(['bank', 'employee_name', 'gross']);
		expect(erasableFields(m, 'lines').sort()).toEqual(['kept', 'memo']); // `amount` is summed by the parent
	});

	it('remove refuses a locked row; anonymise of a personal field on it commits; naming a fixed field is `locked`', () => {
		const paid = { id: 'p1', status: 'paid' };
		expect(Effect.runSync(judgeErase(m, admin, 'payslips', [paid], { mode: 'remove' }, bindings))).toMatchObject({
			ok: false,
			code: 'locked'
		});
		expect(
			Effect.runSync(judgeErase(m, admin, 'payslips', [{ ...paid, status: 'draft' }], { mode: 'remove' }, bindings))
		).toEqual({ ok: true });
		expect(
			Effect.runSync(judgeErase(m, admin, 'payslips', [paid], {
				mode: 'anonymise',
				set: { employee_name: 'Erased' }
			}, bindings))
		).toEqual({ ok: true });
		expect(
			Effect.runSync(judgeErase(m, admin, 'payslips', [paid], { mode: 'anonymise', set: { net: '0' } }, bindings))
		).toMatchObject({ code: 'locked' });
		expect(
			Effect.runSync(judgeErase(m, admin, 'payslips', [paid], { mode: 'anonymise', set: { lines_total: '0' } }, bindings))
		).toMatchObject({ code: 'invalid_input' });
	});

	it('erasure is admin-only and never routes to source approval', () => {
		expect(
			Effect.runSync(judgeErase(m, rep, 'payslips', [{ id: 'p', status: 'draft' }], { mode: 'remove' }, bindings))
		).toMatchObject({ code: 'forbidden' });
		expect(
			Effect.runSync(judgeErase(m, admin, 'payslips', [{ id: 'p', status: 'draft' }], { mode: 'remove' }, bindings))
		).toEqual({ ok: true });
	});
});
