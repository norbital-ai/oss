import { describe, expect, it } from 'vitest';
import * as bolt from '../src/index.ts';
import { collection, customField, model, relationship } from '../src/index.ts';
import './types/registry.ts';

describe('next declarations', () => {
	it('exports only the declaration functions as values (P29)', () => {
		// the closed list of §3.3.10 and Appendix D.2, exactly
		const declarations = ['workspace', 'team', 'app', 'group', 'messages', 'model', 'relationship', 'customField', 'collection',
			'integration', 'pipeline', 'policy', 'envoy', 'mcp', 'automation', 'channel', 'connection'];
		expect(Object.keys(bolt).sort()).toEqual([...declarations].sort());
		for (const value of Object.values(bolt)) expect(typeof value).toBe('function');
	});

	it('model and relationship return their literal: declarations are data', () => {
		const spec = { description: 'x', label: 'name', fields: { name: { kind: 'text' } } } as const;
		expect(model(spec)).toBe(spec);
		const rels = { 'orders.customer': { to: 'customers', inverse: 'orders' } } as const;
		expect(relationship(rels)).toBe(rels);
	});

	it('collection keeps its spec and records each body once, by declared name', () => {
		const c = collection('orders', {
			read: { fields: 'all' },
			queries: { q: { description: 'q', input: {}, output: { kind: 'int' } } },
			actions: { a: { description: 'a', input: {} } }
		});
		expect(c.name).toBe('orders');
		expect(c.spec.read.fields).toBe('all');
		const transform = async <T>(inputs: T) => inputs;
		c.transform(transform);
		c.query('q', async () => 1);
		c.action('a', async () => undefined);
		expect(c.bodies.transform).toBe(transform);
		expect(Object.keys(c.bodies.queries)).toEqual(['q']);
		expect(Object.keys(c.bodies.actions)).toEqual(['a']);
		expect(() => c.transform(transform)).toThrow('transform is attached twice');
		expect(() => c.query('q', async () => 2)).toThrow("queries 'q' is attached twice");
	});

	it('refuses a body for a name the literal does not declare (a build error when tsc is bypassed)', () => {
		const c = collection('orders', { read: { fields: 'all' } });
		// @ts-expect-error the literal declares no queries
		expect(() => c.query('nope', async () => 1)).toThrow("queries 'nope' is not declared");
	});

	it('customField attaches validate at most once', () => {
		const f = customField({ description: 'score', shape: { kind: 'int' } });
		expect(f.check).toBeUndefined();
		const check = (v: number) => (v > 0 ? undefined : 'positive');
		f.validate(check);
		expect(f.check).toBe(check);
		expect(f.check?.(0)).toBe('positive');
		expect(() => f.validate(check)).toThrow('attached twice');
	});
});
