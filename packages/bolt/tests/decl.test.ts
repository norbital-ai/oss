import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { install } from '../src/decl/runtime/guest.ts';
import * as bolt from '../src/index.ts';
import { collection, customField, model, relationship } from '../src/index.ts';
import './types/registry.ts';
install();
const original = (body: object | undefined): unknown =>
	body === undefined
		? undefined
		: Object.getOwnPropertyDescriptor(body, Symbol.for('norbital.bolt.generator'))?.value;
describe('next declarations', () => {
	it.live('exports the declaration functions and the native mask guard as values (P29)', () =>
		Effect.gen(function* () {
			// the closed list of §3.3.10 and Appendix D.2, exactly
			const declarations = [
				'workspace',
				'secrets',
				'team',
				'app',
				'group',
				'kiosk',
				'messages',
				'model',
				'relationship',
				'customField',
				'collection',
				'integration',
				'pipeline',
				'pageServer',
				'policy',
				'mcp',
				'envoy',
				'automation',
				'isMasked'
			];
			expect(Object.keys(bolt).sort()).toEqual([...declarations].sort());
			for (const value of Object.values(bolt)) expect(typeof value).toBe('function');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('model and relationship return their literal: declarations are data', () =>
		Effect.gen(function* () {
			const spec = { description: 'x', label: 'name', fields: { name: { kind: 'text' } } } as const;
			expect(model(spec)).toBe(spec);
			const rels = { 'orders.customer': { to: 'customers', inverse: 'orders' } } as const;
			expect(relationship(rels)).toBe(rels);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('collection keeps its spec and records each body once, by declared name', () =>
		Effect.gen(function* () {
			const c = collection('orders', {
				read: { fields: 'all' },
				queries: { q: { description: 'q', input: {}, output: { kind: 'int' } } },
				actions: { a: { description: 'a', input: {} } }
			});
			expect(c.name).toBe('orders');
			expect(c.spec.read.fields).toBe('all');
			const transform = function* <T>(inputs: T) {
				return inputs;
			};
			c.transform(transform);
			c.query('q', function* () {
				return 1;
			});
			c.action('a', function* () {
				return undefined;
			});
			expect(original(c.bodies.transform)).toBe(transform);
			expect(Object.keys(c.bodies.queries)).toEqual(['q']);
			expect(Object.keys(c.bodies.actions)).toEqual(['a']);
			expect(() => c.transform(transform)).toThrow('transform is attached twice');
			expect(() =>
				c.query('q', function* () {
					return 2;
				})
			).toThrow("queries 'q' is attached twice");
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'infers pure notification event inputs and declared action names without a separate channel',
		() =>
			Effect.gen(function* () {
				const c = collection('orders', {
					read: { fields: 'all' },
					actions: { ping: { description: 'Ping', input: {} } },
					notifications: {
						committed: [
							{
								title: 'Changed',
								on: { action: ['ping'] },
								to: (event) => (event.requestor === null ? [] : [{ user: event.requestor }])
							}
						]
					}
				});
				const rule = c.spec.notifications.committed[0];
				expect(
					rule.to({
						event: 'committed',
						action: 'ping',
						collection: 'orders',
						requestor: 'member',
						approvers: [],
						records: []
					})
				).toEqual([{ user: 'member' }]);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'refuses a body for a name the literal does not declare (a build error when tsc is bypassed)',
		() =>
			Effect.gen(function* () {
				const c = collection('orders', { read: { fields: 'all' } });
				expect(() =>
					// @ts-expect-error the literal declares no queries
					c.query('nope', function* () {
						return 1;
					})
				).toThrow("queries 'nope' is not declared");
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('customField attaches validate at most once', () =>
		Effect.gen(function* () {
			const f = customField({ description: 'score', shape: { kind: 'int' } });
			expect(f.check).toBeUndefined();
			const check = (v: number) => (v > 0 ? undefined : 'positive');
			f.validate(check);
			expect(f.check).toBe(check);
			const validate = f.check;
			if (validate === undefined) throw new Error('custom field validator missing');
			expect(validate(0)).toBe('positive');
			expect(() => f.validate(check)).toThrow('attached twice');
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
