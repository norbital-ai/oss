import { it } from '@effect/vitest';
import { expectTypeOf } from 'vitest';
import {
	schema,
	table,
	type Insert,
	type Json,
	type Patch,
	type PlainTime,
	type Row,
	type Upsert,
	type ValueOf
} from '../src/index.ts';

it('keeps decoded times string-compatible while retaining their brand', () => {
	expectTypeOf<ValueOf<{ kind: 'time' }>>().toEqualTypeOf<PlainTime>();
	expectTypeOf<PlainTime>().toExtend<string>();
	expectTypeOf<PlainTime>().toExtend<Json>();
	expectTypeOf<string>().not.toExtend<PlainTime>();
});

it('omits the initial state on create and retains transition states on update and upsert', () => {
	const declarations = schema({
		ticket: table({
			fields: {
				status: {
					kind: 'state',
					initial: 'draft',
					states: {
						draft: { to: ['submitted'] },
						submitted: { to: ['draft'] }
					}
				}
			}
		})
	});
	type Ticket = typeof declarations;
	expectTypeOf<{}>().toMatchTypeOf<Insert<Ticket, 'ticket'>>();
	expectTypeOf<Insert<Ticket, 'ticket'>['status']>().toEqualTypeOf<'draft' | undefined>();
	expectTypeOf<{ status: 'draft' }>().toMatchTypeOf<Insert<Ticket, 'ticket'>>();
	expectTypeOf<{ status: 'submitted' }>().not.toMatchTypeOf<Insert<Ticket, 'ticket'>>();
	expectTypeOf<Row<Ticket, 'ticket'>['status']>().toEqualTypeOf<'draft' | 'submitted'>();
	expectTypeOf<{ status: 'submitted' }>().toMatchTypeOf<Patch<Ticket, 'ticket'>>();
	expectTypeOf<Upsert<Ticket, 'ticket'>['status']>().toEqualTypeOf<
		'draft' | 'submitted' | undefined
	>();
	expectTypeOf<{ status: 'submitted' }>().toMatchTypeOf<Upsert<Ticket, 'ticket'>>();
	expectTypeOf<{ status: 'missing' }>().not.toMatchTypeOf<Upsert<Ticket, 'ticket'>>();
});

it('accepts decoder literals in nested atomic patches, appends and removals', () => {
	const declarations = schema({
		entry: table({
			fields: {
				payload: {
					kind: 'object',
					fields: {
						price: { kind: 'decimal', scale: 2 },
						on: { kind: 'date' },
						nested: { kind: 'object', fields: { at: { kind: 'instant' } } }
					}
				},
				amounts: { kind: 'list', of: { kind: 'decimal', scale: 2 } },
				days: { kind: 'list', of: { kind: 'date' } }
			}
		})
	});
	type Entry = typeof declarations;
	expectTypeOf<{
		payload: {
			$patch: {
				price: '1.25';
				on: '2026-10-01';
				nested: { at: '2026-10-01T00:00:00Z' };
			};
		};
	}>().toMatchTypeOf<Patch<Entry, 'entry'>>();
	expectTypeOf<{ amounts: { $append: readonly ['1.20', 2] } }>().toMatchTypeOf<
		Patch<Entry, 'entry'>
	>();
	expectTypeOf<{ days: { $remove: readonly ['2026-10-01'] } }>().toMatchTypeOf<
		Patch<Entry, 'entry'>
	>();
	expectTypeOf<{ payload: { $patch: { price: 'expensive' } } }>().not.toMatchTypeOf<
		Patch<Entry, 'entry'>
	>();
	expectTypeOf<{ amounts: { $append: readonly ['expensive'] } }>().not.toMatchTypeOf<
		Patch<Entry, 'entry'>
	>();
	expectTypeOf<{ days: { $remove: readonly ['yesterday'] } }>().not.toMatchTypeOf<
		Patch<Entry, 'entry'>
	>();
});

it('includes null for defaulted inline members while preserving required members', () => {
	type Inline = ValueOf<{
		kind: 'object';
		fields: {
			name: { kind: 'text'; default: 'Untitled' };
			quantity: { kind: 'int' };
		};
	}>;
	expectTypeOf<Inline['name']>().toEqualTypeOf<string | null | undefined>();
	expectTypeOf<Inline['quantity']>().toEqualTypeOf<number>();
	expectTypeOf<{ quantity: number }>().toMatchTypeOf<Inline>();
	expectTypeOf<{ quantity: number; name: null }>().toMatchTypeOf<Inline>();
	expectTypeOf<{ quantity: null }>().not.toMatchTypeOf<Inline>();
});

it('preserves named object fields and the possible values of dynamic rest keys', () => {
	type Inline = ValueOf<{
		kind: 'object';
		fields: { name: { kind: 'text' } };
		rest: { kind: 'int' };
	}>;
	expectTypeOf<Inline['name']>().toEqualTypeOf<string>();
	expectTypeOf<Inline[string]>().toEqualTypeOf<string | number>();
	expectTypeOf<{ name: string; count: number }>().toMatchTypeOf<Inline>();
	expectTypeOf<{ name: string; count: boolean }>().not.toMatchTypeOf<Inline>();
});

it('keeps many custom values as arrays of their decoded JSON values', () => {
	type Many = ValueOf<{ kind: 'custom'; of: 'opaque'; many: true }>;
	expectTypeOf<Many>().toEqualTypeOf<readonly Json[]>();
	expectTypeOf<string>().not.toMatchTypeOf<Many>();
	expectTypeOf<
		ValueOf<{ kind: 'custom'; of: 'opaque'; many: true; optional: true }>
	>().toEqualTypeOf<readonly Json[] | null>();
});
