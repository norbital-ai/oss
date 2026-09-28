// Type corpus for gaps found migrating real templates (CTX-TYPES): query `refuse` and `similar`, `ctx.act` upsert with
// `onConflict`, transform-filled create fields, custom `default`/`many`, untagged unions. Each `@ts-expect-error` is a
// planted mistake.
import { customField, model } from '../../src/index.ts';
import type { AutomationCtx, Decimal, Id, Insert } from '../../src/index.ts';
import type { ValueOf } from '../../src/decl/fields.ts';
import * as c from './fixture/collections.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;

// (1) a query refuses; queries and actions run named similarity searches
c.orders.query('open_total', async ({ since }, ctx) => {
	if (String(since) === '') ctx.refuse('no date', { field: 'since' });
	const near = await ctx.similar('orders', 'by_colour', { lab: [1, 2, 3] }, { limit: 3, select: { note: true } });
	const d: number = near[0]!.$distance; const n: string | null = near[0]!.note; void d; void n;
	return 0 as unknown as Decimal;
});
// @ts-expect-error S1 an undeclared similarity
c.orders.query('open_total', async (_, ctx) => { await ctx.similar('orders', 'by_shape', {}, { limit: 1 }); return 0 as unknown as Decimal; });
// @ts-expect-error S2 a similarity input of the wrong shape
c.orders.query('open_total', async (_, ctx) => { await ctx.similar('orders', 'by_colour', { lab: 'red' }, { limit: 1 }); return 0 as unknown as Decimal; });
is<Eq<'refuse' extends keyof AutomationCtx ? 1 : 0, 0>>();   // automations have no refuse

// (2) upsert from an action takes onConflict
c.orders.action('renote', async (_, ctx) => {
	await ctx.act('notice_notes.upsert', { notice: 'n' as Id<'notices'>, note: 'x' }, { onConflict: 'update' });
	await ctx.act('notice_notes.upsert', { id: 'n1' as Id<'notice_notes'>, note: 'y' }, { onConflict: 'update' });
	return 1;
});
// @ts-expect-error U1 upsert without onConflict (rule 28)
c.orders.action('renote', async (_, ctx) => { await ctx.act('notice_notes.upsert', { notice: 'n' as Id<'notices'>, note: 'x' }); return 1; });

// (4) a create field the transform fills is optional in the input
is<Eq<Insert<'customers'>, { readonly name?: string; readonly email?: string | null; readonly tier?: 'basic' | 'gold' }>>();
c.orders.action('renote', async (_, ctx) => { await ctx.act('customers.create', { email: 'a@b.c' }); return 1; });

// (5) a custom field takes a default and `many`
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' },
	r: { kind: 'custom', of: 'rating', default: { score: 3 } }, rs: { kind: 'custom', of: 'rating', many: true, default: [] } } });
is<Eq<ValueOf<{ kind: 'custom'; of: 'rating'; many: true }>, readonly { readonly score: number; readonly note?: string | null }[]>>();
// @ts-expect-error K1 a custom default of the wrong shape
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' }, r: { kind: 'custom', of: 'rating', default: { score: 'high' } } } });

// (6) an untagged scalar union
const v = customField({ description: 'x', shape: { kind: 'object', fields: {
	value: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'number' }, { kind: 'text' }] } } } });
v.validate((x) => (typeof x.value === 'string' || typeof x.value === 'number' || typeof x.value === 'boolean' ? undefined : 'never'));
is<Eq<ValueOf<{ kind: 'union'; of: readonly [{ kind: 'number' }, { kind: 'text' }] }>, number | string>>();
// @ts-expect-error K2 an untagged union arm of unknown kind
customField({ description: 'x', shape: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'nmber' }] } });
