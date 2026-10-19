import { Effect, Schema } from 'effect';
import { Instant } from '@norbital-ai/std/date';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { install } from '../src/decl/runtime/guest.ts';
import * as bolt from '../src/index.ts';
import {
	app,
	automation,
	envoy,
	group,
	integration,
	mcp,
	pipeline,
	workspace
} from '../src/index.ts';
import type { RecordRef } from '../src/index.ts';
import type { Json } from '../src/decl/values.ts';
import * as rt from './types/fixture/runtime.ts';
import './types/registry.ts';
install();
const original = (body: object | undefined): unknown =>
	body === undefined
		? undefined
		: Object.getOwnPropertyDescriptor(body, Symbol.for('norbital.bolt.generator'))?.value;
const OrderRef = Schema.declare((input: unknown): input is RecordRef<'orders'> =>
	Schema.is(
		Schema.Struct({
			collection: Schema.Literal('orders'),
			id: Schema.String.check(Schema.isUUID())
		})
	)(input)
);
const MessageRef = Schema.declare((input: unknown): input is RecordRef<'sys_message'> =>
	Schema.is(
		Schema.Struct({
			collection: Schema.Literal('sys_message'),
			id: Schema.String.check(Schema.isUUID())
		})
	)(input)
);
describe('next runtime declarations', () => {
	it.live('exports the runtime declaration functions (P29)', () =>
		Effect.gen(function* () {
			for (const declaration of [
				bolt.workspace,
				bolt.app,
				bolt.group,
				bolt.integration,
				bolt.pipeline,
				bolt.mcp,
				bolt.envoy,
				bolt.automation
			])
				expect(typeof declaration).toBe('function');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('literal declarations return their literal: declarations are data', () =>
		Effect.gen(function* () {
			const ws = {
				tz: 'UTC',
				locale: 'en',
				connections: { mail: { integration: 'email' } }
			} as const;
			expect(workspace(ws)).toBe(ws);
			const m = { description: 'docs', url: 'MCP_URL' } as const;
			expect(mcp(m)).toBe(m);
			const e = {
				name: 'Norbius',
				audience: 'private',
				policies: ['sales_rep'],
				delegation: 'disabled',
				dm: 'envoy',
				task: 'x'
			} as const;
			expect(envoy(e)).toBe(e);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('per-collection and per-folder declarations carry their name', () =>
		Effect.gen(function* () {
			expect(rt.orders_pipeline.name).toBe('orders');
			expect(
				pipeline('orders', { export: { description: 'x', select: ['number'], format: 'csv' } }).spec
					.export?.format
			).toBe('csv');
			expect(
				app('portal', {
					title: 'P',
					description: 'P',
					icon: 'x',
					pages: { tickets: { title: 'T' } }
				}).name
			).toBe('portal');
			expect(
				group('ops', { label: 'Ops', icon: 'x', defaultChild: 'sales' }).spec.defaultChild
			).toBe('sales');
			expect(rt.kingdee.name).toBe('kingdee');
			expect(rt.kingdee.spec.feeds.products.into).toBe('products');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('an automation keeps its literal and takes its run body exactly once', () =>
		Effect.gen(function* () {
			const a = automation({
				description: 'x',
				runAs: ['sales_rep'],
				on: { created: 'orders' },
				output: { kind: 'int' }
			});
			expect(a.spec.on).toEqual({ created: 'orders' });
			expect(a.body).toBeUndefined();
			const body = function* ({ ids }: { readonly ids: readonly unknown[] }) {
				return ids.length;
			};
			a.run(body);
			expect(original(a.body)).toBe(body);
			expect(() => a.run(body)).toThrow('run is attached twice');
			expect(rt.nightly.body).toBeTypeOf('function');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('an integration attaches each declared body once, by name (X-2)', () =>
		Effect.gen(function* () {
			const i = integration('kingdee', {
				description: 'x',
				driver: 'sqlserver',
				feeds: { products: { into: 'products', key: ['external_code'], cron: '@hourly' } },
				outbound: { orders: { from: 'orders', via: 'ledger' } }
			});
			expect(i.bodies).toEqual({ feeds: {}, outbound: {} });
			const read = function* (cursor: Json | null) {
				return { changes: [], cursor, more: false };
			};
			i.feed('products', { read });
			expect(original(i.bodies.feeds['products']?.read)).toBe(read);
			expect(() => i.feed('products', { read })).toThrow("feeds 'products' is attached twice");
			expect(() => {
				// @ts-expect-error the runtime also refuses an undeclared feed from unchecked JavaScript source
				i.feed('stock', { read });
			}).toThrow("feeds 'stock' is not declared");
			const build = () => ({ n: 1 }),
				run = function* () {
					return { id: 'r1' };
				};
			i.outbound('orders', { build, run });
			expect({
				...i.bodies.outbound['orders'],
				run: original(i.bodies.outbound['orders']?.run)
			}).toEqual({ build, run });
			const test = function* () {};
			i.test(test);
			expect(original(i.bodies.test)).toBe(test);
			expect(() => i.test(test)).toThrow('test is attached twice');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('outbound bodies are pure functions of the committed row', () =>
		Effect.gen(function* () {
			const confirmations = rt.support_mail.bodies.outbound['confirmations'];
			expect(confirmations?.build).toBe(rt.confirmationBuild);
			expect(confirmations?.events?.bounced).toBe(rt.confirmationBounced);
			const order = yield* Schema.decodeUnknownEffect(OrderRef)({
				collection: 'orders',
				id: '0199a000-0000-7000-8000-000000000001'
			});
			const message = yield* Schema.decodeUnknownEffect(MessageRef)({
				collection: 'sys_message',
				id: '0199a000-0000-7000-8000-000000000002'
			});
			expect(rt.confirmationBuild({ number: 'SO-0001', note: null, id: order.id })).toEqual({
				to: ['sales@example.com'],
				subject: 'Order SO-0001',
				text: '',
				thread: order.id
			});
			expect(
				rt.confirmationBounced({
					kind: 'bounced',
					at: Instant('2026-10-14T00:00:00Z'),
					message: message.id,
					provider: 'fixture',
					reason: 'mailbox full'
				})
			).toEqual({ note: 'mailbox full' });
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
class TestFailure extends Schema.TaggedError<TestFailure>()('TestFailure', {
	cause: Schema.Defect()
}) {}
