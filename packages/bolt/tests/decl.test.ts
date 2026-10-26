import { describe, expect, it } from 'vitest';
import { install } from '../src/decl/runtime/guest.ts';
import * as bolt from '../src/index.ts';
import { customField, model } from '../src/index.ts';
import { splitModel } from '../src/decl/model.ts';
import * as fixtures from './types/fixture/models.ts';
import './types/registry.ts';

install();
const original = (body: object | undefined): unknown =>
	body === undefined
		? undefined
		: Object.getOwnPropertyDescriptor(body, Symbol.for('norbital.bolt.generator'))?.value;

describe('declarations', () => {
	it('exports the declaration functions and pure public helpers', () => {
		const names = [
			'workspace',
			'secrets',
			'team',
			'app',
			'group',
			'kiosk',
			'messages',
			'model',
			'customField',
			'integration',
			'instanceId',
			'isInstance',
			'pageServer',
			'policy',
			'mcp',
			'envoy',
			'automation',
			'isMasked',
			'jsonDiff'
		];
		expect(Object.keys(bolt).sort()).toEqual(names.sort());
		for (const value of Object.values(bolt)) expect(typeof value).toBe('function');
	});

	it('keeps one named model literal and wraps every inline guest body at its own path', () => {
		const spec = fixtures.orders.spec;
		const declared = model('orders', spec);
		expect(declared.name).toBe('orders');
		expect(declared.spec).toBe(spec);
		expect(original(declared.bodies.create)).toBe(spec.create.transform);
		expect(original(declared.bodies.update)).toBe(spec.update.transform);
		expect(original(declared.bodies.delete)).toBe(spec.delete.check);
		expect(original(declared.bodies.queries['open_total'])).toBe(spec.queries.open_total.run);
		expect(original(declared.bodies.notify)).toBe(spec.notify);
	});

	it('splits storage, refs and exposure without leaking functions into the generated data', () => {
		const parts = splitModel('orders', fixtures.orders.spec);
		expect(parts.model.fields).not.toHaveProperty('customer');
		expect(parts.relationships['orders.customer']).toMatchObject({
			to: 'customers',
			inverse: 'orders'
		});
		expect(parts.collection?.create?.transform).toBe(true);
		expect(parts.collection?.update?.transform).toBe(true);
		expect(parts.collection?.delete).toEqual({ check: true });
		expect(parts.collection?.notify).toBe(true);
		expect(parts.collection?.queries?.['open_total']).not.toHaveProperty('run');
		expect(parts.collection?.read).toEqual({ fields: 'all', relations: 'all' });
		const privateModel = splitModel('private', {
			description: 'Private rows',
			label: 'name',
			fields: { name: { kind: 'text' } }
		});
		expect(privateModel.collection).toBeUndefined();
	});

	it('keeps a custom field validator inside its named literal', () => {
		const validate = (value: Parameters<NonNullable<typeof fixtures.rating.check>>[0]) =>
			value.score > 0 ? undefined : 'positive';
		const field = customField('rating', {
			description: 'Score',
			shape: {
				kind: 'object',
				fields: { score: { kind: 'int', min: 1, max: 5 }, note: { kind: 'text', optional: true } }
			},
			validate
		});
		expect(field.name).toBe('rating');
		expect(field.check).toBe(validate);
		expect(field.spec.validate).toBe(validate);
		expect(field.check?.({ score: 0 })).toBe('positive');
	});
});
