// A write listener's trigger names the ids of the model it heard, so the body queries them as typed ids; a `where`
// on a system model mixes field filters with `or` as on any model.
import { expectTypeOf } from '@effect/vitest';
import { automation } from '../../src/index.ts';
import type { Id } from '../../src/index.ts';
import type { Where } from '../../src/decl/where.ts';
import './registry.ts';

automation({
	description: 'Hears members and invitations',
	policies: ['sales_rep'],
	on: [{ model: 'sys_user', verbs: ['create', 'update'] }, { model: 'sys_invitation', verbs: ['create'] }],
	run: function* (_, ctx) {
		const t = ctx.run.trigger;
		if (t.kind === 'system' && t.cause === 'event') {
			if (t.model === 'sys_user') {
				expectTypeOf(t.records).toEqualTypeOf<readonly Id<'sys_user'>[]>();
				expectTypeOf(t.verb).toEqualTypeOf<'create' | 'update'>();
				yield* ctx.query({ sys_user: { where: { id: { in: t.records } } } });
			} else {
				expectTypeOf(t.model).toEqualTypeOf<'sys_invitation'>();
				expectTypeOf(t.records).toEqualTypeOf<readonly Id<'sys_invitation'>[]>();
				expectTypeOf(t.verb).toEqualTypeOf<'create'>();
				const { sys_invitation } = yield* ctx.query({
					sys_invitation: {
						where: {
							id: { in: t.records },
							accepted_at: { is_null: true },
							revoked_at: { is_null: true },
							expires_at: { gt: ctx.now },
							team: { eq: 'sales' },
							or: [{ email: { eq: 'a@b.example' } }, { phone: { eq: '+6581234567' } }]
						}
					}
				});
				expectTypeOf(sys_invitation.rows[0]?.id).toEqualTypeOf<Id<'sys_invitation'> | undefined>();
			}
		}
	}
});

automation({
	description: 'A cron run hears no write',
	policies: ['sales_rep'],
	on: [{ cron: '@daily' }],
	run: function* (_, ctx) {
		const t = ctx.run.trigger;
		// @ts-expect-error no listener declared: no event trigger
		if (t.kind === 'system' && t.cause === 'event') void t.records;
	}
});

const open: Where<'sys_invitation'> = {
	accepted_at: { is_null: true },
	revoked_at: { is_null: true },
	or: [{ email: { eq: 'a@b.example' } }, { phone: { eq: '+6581234567' } }]
};
void open;
