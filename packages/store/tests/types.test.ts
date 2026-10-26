import { it } from '@effect/vitest';
import { expectTypeOf } from 'vitest';
import type { Effect } from 'effect';
import type { Decimal } from '@norbital-ai/std/decimal';
import type { PlainDate } from '@norbital-ai/std/date';
import { Instant } from '@norbital-ai/std/date';
import {
	schema,
	store,
	table,
	type AggregateQuery,
	type ClockColumn,
	type Id,
	type Insert,
	type Key,
	type OrderBy,
	type Patch,
	type Row,
	type Select,
	type Statement,
	type TableName,
	type Where,
	type With
} from '../src/index.ts';
import { shop } from './fixture.ts';

type Answer<E> = Effect.Success<E> extends Statement<infer A> ? A : never;
type Listed<E> = Answer<E> extends { readonly rows: readonly (infer R)[] } ? R : never;
type Shop = typeof shop;

it('infers set-based host query results without widening fields or scalar values', () => {
	const db = store(shop);
	const changed = db.updateMany(
		'environment',
		[{ key: { tenant: 'acme', name: 'live' }, match: { generation: 2 }, set: { generation: 3 } }],
		{ select: { generation: true } }
	);
	expectTypeOf<Answer<typeof changed>[number]>().toEqualTypeOf<{
		readonly tenant: string;
		readonly name: string;
		readonly generation: number;
	}>();
	const joined = db.related('environment', {
		to: 'tenant',
		on: { tenant: 'handle' },
		select: { name: true },
		limit: 1
	});
	expectTypeOf<Answer<typeof joined>[number]>().toEqualTypeOf<{
		readonly handle: string;
		readonly name: string;
	}>();
	const values = db.union([
		{ table: 'tenant', field: 'handle' },
		{ table: 'environment', field: 'tenant' }
	]);
	expectTypeOf<Answer<typeof values>>().toEqualTypeOf<readonly string[]>();
	const declaration = schema({
		reading: table({
			key: ['at', 'source'],
			fields: { at: { kind: 'instant' }, source: { kind: 'text' }, value: { kind: 'number' } }
		})
	});
	const readings = store(declaration);
	const window = readings.rollup('reading', {
		by: ['source'],
		time: 'at',
		value: 'value',
		stepMillis: 60_000,
		combine: 'max'
	});
	expectTypeOf<Answer<typeof window>[number]['at']>().toEqualTypeOf<number>();
	expectTypeOf<Answer<typeof window>[number]['key']>().toEqualTypeOf<{ readonly source: string }>();
	const carried = readings.rollup('reading', {
		by: ['source'],
		time: 'at',
		value: 'value',
		latestPer: ['source'],
		carry: {
			from: Instant('2026-01-01T00:00:00.000Z'),
			until: Instant('2026-01-01T00:01:00.000Z'),
			stepMillis: 60_000
		}
	});
	expectTypeOf<Answer<typeof carried>[number]['at']>().toEqualTypeOf<number>();
	const summary = readings.rollup('reading', { by: ['source'], time: 'at', value: 'value' });
	expectTypeOf<Answer<typeof summary>[number]['at']>().toEqualTypeOf<null>();
	expectTypeOf<Answer<typeof summary>[number]>().not.toBeAny();
});

it('keeps literal projections and polymorphic result arms exact', () => {
	const db = store(shop);
	const selected = db.read('order', { select: { number: true }, all: true });
	expectTypeOf<keyof Listed<typeof selected>>().toEqualTypeOf<'id' | 'number'>();
	expectTypeOf<Listed<typeof selected>['id']>().toEqualTypeOf<Id<'order'>>();
	expectTypeOf<Listed<typeof selected>['number']>().toEqualTypeOf<string>();
	const grouped = db.read('order', { firstPer: ['status'], select: { number: true }, all: true });
	expectTypeOf<keyof Listed<typeof grouped>>().toEqualTypeOf<'id' | 'number'>();

	const nested = db.read('order', {
		select: { number: true },
		with: {
			customer: { select: { code: true } },
			lines: { select: { sku: true }, all: true }
		},
		all: true
	});
	expectTypeOf<keyof Listed<typeof nested>>().toEqualTypeOf<
		'id' | 'number' | 'customer' | 'lines'
	>();
	expectTypeOf<keyof Listed<typeof nested>['customer']>().toEqualTypeOf<'id' | 'code'>();
	expectTypeOf<keyof Listed<typeof nested>['lines'][number]>().toEqualTypeOf<'id' | 'sku'>();

	const polymorphic = db.read('note', {
		select: { body: true },
		with: {
			about: {
				customer: { select: { code: true } },
				order: { select: { number: true } }
			}
		},
		all: true
	});
	type About = Listed<typeof polymorphic>['about'];
	expectTypeOf<Extract<About, { collection: 'customer' }>>().toEqualTypeOf<{
		readonly id: Id<'customer'>;
		readonly collection: 'customer';
		readonly code: string;
	}>();
	expectTypeOf<Extract<About, { collection: 'order' }>>().toEqualTypeOf<{
		readonly id: Id<'order'>;
		readonly collection: 'order';
		readonly number: string;
	}>();
	expectTypeOf<Extract<About, null>>().toEqualTypeOf<null>();
});

it('refuses invalid literal fields, values, paths and relation operators', () => {
	expectTypeOf<'missing'>().not.toMatchTypeOf<TableName<Shop>>();
	expectTypeOf<{ missing: true }>().not.toMatchTypeOf<Select<Shop, 'order'>>();
	expectTypeOf<{ lines: true }>().not.toMatchTypeOf<Select<Shop, 'order'>>();
	expectTypeOf<{ missing: { eq: 1 } }>().not.toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ total: { eq: 'twelve' } }>().not.toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ status: { eq: 'cancelled' } }>().not.toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ customer: { some: {} } }>().not.toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ address: { floor: { gt: 'high' } } }>().not.toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ labels: { some: { eq: 1 } } }>().not.toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ address: { city: { eq: 'Seoul' } } }>().toMatchTypeOf<Where<Shop, 'order'>>();
	expectTypeOf<{ 'address.city': 'asc' }>().toMatchTypeOf<OrderBy<Shop, 'order'>>();
	expectTypeOf<{ 'address.missing': 'asc' }>().not.toMatchTypeOf<OrderBy<Shop, 'order'>>();
	expectTypeOf<{ address: 'asc' }>().not.toMatchTypeOf<OrderBy<Shop, 'order'>>();
	expectTypeOf<{ lines: { select: { sku: true } } }>().not.toMatchTypeOf<With<Shop, 'order'>>();
	expectTypeOf<{ customer: { select: { sku: true } } }>().not.toMatchTypeOf<With<Shop, 'order'>>();
});

it('preserves required write fields, typed refs and atomic change shapes', () => {
	type NewOrder = Insert<Shop, 'order'>;
	expectTypeOf<{
		number: string;
		customer: Id<'customer'>;
		placed_on: '2026-10-01';
		total: '1.25';
	}>().toMatchTypeOf<NewOrder>();
	expectTypeOf<Omit<NewOrder, 'number'>>().not.toMatchTypeOf<NewOrder>();
	expectTypeOf<{}>().toMatchTypeOf<Pick<NewOrder, 'status' | 'address' | 'labels' | 'events'>>();
	expectTypeOf<'revision'>().not.toMatchTypeOf<keyof NewOrder>();
	expectTypeOf<ClockColumn<Shop, 'environment'>>().toEqualTypeOf<'deleted_at'>();
	expectTypeOf<ClockColumn<Shop, 'customer'>>().toEqualTypeOf<never>();
	const clocked = schema({
		event: table({
			key: ['at'],
			audit: true,
			fields: { at: { kind: 'instant' }, checked_at: { kind: 'instant' } }
		})
	});
	expectTypeOf<ClockColumn<typeof clocked, 'event'>>().toEqualTypeOf<'checked_at'>();
	expectTypeOf<Id<'order'>>().not.toMatchTypeOf<Id<'customer'>>();
	expectTypeOf<{ address: { $patch: { floor: 4 } } }>().toMatchTypeOf<Patch<Shop, 'order'>>();
	expectTypeOf<{ address: { $patch: { floor: 'high' } } }>().not.toMatchTypeOf<
		Patch<Shop, 'order'>
	>();
	expectTypeOf<{ labels: { $append: readonly ['vip'] } }>().toMatchTypeOf<Patch<Shop, 'order'>>();
	expectTypeOf<{ labels: { $append: readonly [1] } }>().not.toMatchTypeOf<Patch<Shop, 'order'>>();
	expectTypeOf<{ total: { $patch: {} } }>().not.toMatchTypeOf<Patch<Shop, 'order'>>();
	expectTypeOf<Key<Shop, 'environment'>>().toEqualTypeOf<{
		readonly tenant: string;
		readonly name: string;
	}>();
});

it('uses identity and natural keys in ordinary and polymorphic refs', () => {
	const declarations = schema({
		owner: table({ key: 'identity', fields: { name: { kind: 'text' } } }),
		tenant: table({ key: ['handle'], fields: { handle: { kind: 'text' } } }),
		document: table({
			fields: {
				owner: { kind: 'ref', to: 'owner' },
				about: { kind: 'ref', to: ['owner', 'tenant'], optional: true }
			}
		})
	});
	type Declarations = typeof declarations;
	expectTypeOf<Row<Declarations, 'owner'>['id']>().toEqualTypeOf<number>();
	expectTypeOf<Key<Declarations, 'owner'>>().toEqualTypeOf<{ readonly id: number }>();
	expectTypeOf<Key<Declarations, 'tenant'>>().toEqualTypeOf<{ readonly handle: string }>();
	expectTypeOf<Row<Declarations, 'document'>['owner']>().toEqualTypeOf<number>();
	expectTypeOf<Row<Declarations, 'document'>['about']>().toEqualTypeOf<
		| { readonly collection: 'owner'; readonly id: number }
		| { readonly collection: 'tenant'; readonly id: string }
		| null
	>();
	expectTypeOf<{ owner: number; about: { collection: 'tenant'; id: string } }>().toMatchTypeOf<
		Insert<Declarations, 'document'>
	>();
	expectTypeOf<{ owner: string }>().not.toMatchTypeOf<Insert<Declarations, 'document'>>();
	expectTypeOf<{ owner: number; about: { collection: 'owner'; id: string } }>().not.toMatchTypeOf<
		Insert<Declarations, 'document'>
	>();
});

it('derives reference and lookup types from text, uuid, identity and natural integer keys', () => {
	const declarations = schema({
		text_owner: table({ key: 'text', fields: { name: { kind: 'text' } } }),
		uuid_owner: table({ fields: { name: { kind: 'text' } } }),
		serial_owner: table({ key: 'identity', fields: { name: { kind: 'text' } } }),
		integer_owner: table({ key: ['code'], fields: { code: { kind: 'int' } } }),
		reference: table({
			fields: {
				text: { kind: 'ref', to: 'text_owner' },
				uuid: { kind: 'ref', to: 'uuid_owner', optional: true },
				serial: { kind: 'ref', to: 'serial_owner', optional: true },
				integer: { kind: 'ref', to: 'integer_owner', optional: true },
				about: {
					kind: 'ref',
					to: ['text_owner', 'uuid_owner', 'serial_owner', 'integer_owner'],
					optional: true
				}
			}
		})
	});
	type Declarations = typeof declarations;
	type Reference = Row<Declarations, 'reference'>;
	expectTypeOf<Row<Declarations, 'text_owner'>['id']>().toEqualTypeOf<string>();
	expectTypeOf<Key<Declarations, 'text_owner'>>().toEqualTypeOf<{ readonly id: string }>();
	expectTypeOf<Row<Declarations, 'uuid_owner'>['id']>().toEqualTypeOf<Id<'uuid_owner'>>();
	expectTypeOf<Reference['text']>().toEqualTypeOf<string>();
	expectTypeOf<Reference['uuid']>().toEqualTypeOf<Id<'uuid_owner'> | null>();
	expectTypeOf<Reference['serial']>().toEqualTypeOf<number | null>();
	expectTypeOf<Reference['integer']>().toEqualTypeOf<number | null>();
	expectTypeOf<
		Extract<Reference['about'], { collection: 'text_owner' }>['id']
	>().toEqualTypeOf<string>();
	expectTypeOf<Extract<Reference['about'], { collection: 'uuid_owner' }>['id']>().toEqualTypeOf<
		Id<'uuid_owner'>
	>();
	expectTypeOf<
		Extract<Reference['about'], { collection: 'serial_owner' }>['id']
	>().toEqualTypeOf<number>();
	expectTypeOf<
		Extract<Reference['about'], { collection: 'integer_owner' }>['id']
	>().toEqualTypeOf<number>();
	expectTypeOf<{
		text: string;
		serial: number;
		integer: number;
		about: { collection: 'text_owner'; id: string };
	}>().toMatchTypeOf<Insert<Declarations, 'reference'>>();
	expectTypeOf<{ text: string; about: { collection: 'serial_owner'; id: number } }>().toMatchTypeOf<
		Patch<Declarations, 'reference'>
	>();
	expectTypeOf<{
		text: { eq: string };
		serial: { eq: number };
		integer: { in: readonly number[] };
	}>().toMatchTypeOf<Where<Declarations, 'reference'>>();
	expectTypeOf<{ text: number }>().not.toMatchTypeOf<Insert<Declarations, 'reference'>>();
	expectTypeOf<{ text: string; uuid: string }>().not.toMatchTypeOf<
		Insert<Declarations, 'reference'>
	>();
	expectTypeOf<{
		text: string;
		about: { collection: 'serial_owner'; id: string };
	}>().not.toMatchTypeOf<Insert<Declarations, 'reference'>>();
	const db = store(declarations);
	const created = db.create('reference', { text: 'plain-key', serial: 1, integer: 7 });
	expectTypeOf<Answer<typeof created>[number]['text']>().toEqualTypeOf<string>();
	const lookup = db.get('text_owner', { id: 'plain-key' });
	expectTypeOf<NonNullable<Answer<typeof lookup>>['id']>().toEqualTypeOf<string>();
	const removed = db.delete('text_owner', { key: { id: 'plain-key' } });
	expectTypeOf<Answer<typeof removed>[number]>().toEqualTypeOf<{ readonly id: string }>();
});

it('returns only requested aggregate metrics and typed bucket keys', () => {
	const db = store(shop);
	const totals = db.aggregate('order', {
		count: true,
		sum: ['total'],
		avg: ['total'],
		min: ['placed_on', 'customer.code']
	});
	expectTypeOf<keyof Answer<typeof totals>>().toEqualTypeOf<'count' | 'sum' | 'avg' | 'min'>();
	expectTypeOf<Answer<typeof totals>['count']>().toEqualTypeOf<number>();
	expectTypeOf<keyof Answer<typeof totals>['sum']>().toEqualTypeOf<'total'>();
	expectTypeOf<Answer<typeof totals>['sum']['total']>().toEqualTypeOf<Decimal | null>();
	expectTypeOf<Answer<typeof totals>['avg']['total']>().toEqualTypeOf<Decimal | null>();
	expectTypeOf<Answer<typeof totals>['min']['placed_on']>().toEqualTypeOf<PlainDate | null>();
	expectTypeOf<Answer<typeof totals>['min']['customer.code']>().toEqualTypeOf<string | null>();
	const grouped = db.aggregate('order', { by: { month: 'placed_on' }, count: true, all: true });
	expectTypeOf<keyof Answer<typeof grouped>>().toEqualTypeOf<'rows' | 'next'>();
	expectTypeOf<Listed<typeof grouped>['key']>().toEqualTypeOf<{
		readonly placed_on: PlainDate | null;
	}>();
	expectTypeOf<{ sum: readonly ['number'] }>().not.toMatchTypeOf<AggregateQuery<Shop, 'order'>>();
	expectTypeOf<{ max: readonly ['missing'] }>().not.toMatchTypeOf<AggregateQuery<Shop, 'order'>>();
	expectTypeOf<{ by: 'status'; count: true }>().not.toMatchTypeOf<AggregateQuery<Shop, 'order'>>();
	expectTypeOf<{ by: 'status'; count: true; all: true; after: string }>().not.toMatchTypeOf<
		AggregateQuery<Shop, 'order'>
	>();
});
