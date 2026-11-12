import { describe, expect, it } from 'vitest';
import { Option, Schema } from 'effect';
import { KindSchema } from '@norbital-ai/std/kind';
import { install } from '../src/decl/runtime/guest.ts';
import { custom_field, policy } from '../src/index.ts';
import { bind_model } from '../src/declarations.ts';
import { split_model, split_system_model } from '../src/decl/model-data.ts';
import { FieldData, OutputData } from '../src/decl/field-data.ts';
import { nullable_of_expr } from '../src/decl/model.ts';
import * as declarations from '../src/declarations.ts';
import message from '../src/system/data/model/sys_message/+model.ts';
import configuration from '../src/system/data/model/sys_config/+model.ts';
import { salesRep } from './types/access.ts';
import * as fixtures from './types/fixture/models.ts';
import './types/registry.ts';

install();
const original = (body: object | undefined): unknown =>
	body === undefined
		? undefined
		: Object.getOwnPropertyDescriptor(body, Symbol.for('norbital.bolt.generator'))?.value;

describe('declarations', () => {
	it('policy returns its literal with a verdict callback on each write grant', () => {
		expect(policy(salesRep)).toBe(salesRep);
		expect(salesRep.grants.orders).toMatchObject({
			create: { verdict: expect.any(Function) },
			update: { verdict: expect.any(Function) },
			delete: { verdict: expect.any(Function) }
		});
	});

	it('keeps one named model literal and wraps every inline guest body at its own path', () => {
		const spec = fixtures.orders.spec;
		const declared = bind_model('orders')(spec);
		expect(declared.name).toBe('orders');
		expect(declared.spec).toBe(spec);
		expect(original(declared.bodies.create)).toBe(spec.create.transform);
		expect(original(declared.bodies.update)).toBe(spec.update.transform);
		for (const verb of ['create', 'update', 'delete'] as const)
			expect(original(declared.bodies.effect[verb])).toBe(spec[verb].effect);
		expect(declared.bodies).not.toHaveProperty('delete');
		expect(declared.bodies).not.toHaveProperty('notify');
	});

	it('splits storage, refs and exposure without leaking functions into the generated data', () => {
		const parts = split_model('orders', fixtures.orders.spec);
		expect(parts.model.fields).not.toHaveProperty('customer');
		expect(parts.relationships['orders.customer']).toMatchObject({
			to: 'customers',
			inverse: 'orders'
		});
		expect(parts.exposure?.create?.transform).toBe(true);
		expect(parts.exposure?.update?.transform).toBe(true);
		expect(parts.exposure?.create?.effect).toBe(true);
		expect(parts.exposure?.update?.effect).toBe(true);
		expect(parts.exposure?.delete).toEqual({ effect: true });
		expect(parts.exposure).not.toHaveProperty('notify');
		// the read layer map keys by path, the root first
		expect(Object.keys(parts.exposure?.outputs.default ?? {})[0]).toBe('orders');
		const privateModel = split_model('private', {
			description: 'Private rows',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		});
		expect(privateModel.exposure).toBeUndefined();
	});

	it('takes declaration text from the catalogue without interpreting literal business values as descriptors', () => {
		const field = Schema.decodeUnknownOption(FieldData);
		for (const descriptor of [
			{ kind: 'text', label: 'Old caption' },
			{ kind: 'json', shape: { kind: 'object', fields: { note: { kind: 'text', help: 'Old help' } } } },
			{ kind: 'record', of: { kind: 'text', label: 'Old caption' } },
			{ kind: 'union', by: 'type', arms: { note: { text: { kind: 'text', help: 'Old help' } } } }
		]) expect(Option.isNone(field(descriptor))).toBe(true);
		expect(Option.isSome(field({ kind: 'json', default: { label: 'Business label', help: 'Business help' } }))).toBe(true);
		expect(Option.isNone(Schema.decodeUnknownOption(OutputData)({
			kind: 'object', fields: { order: { kind: 'row', of: 'orders', label: 'Old caption' } }
		}))).toBe(true);
		expect(Option.isSome(Schema.decodeUnknownOption(KindSchema)({
			kind: 'text', label: 'Standalone view caption', help: 'Standalone view help'
		}))).toBe(true);
		expect(() => split_model('notes', {
			description: 'Notes', fields: { note: { kind: 'text', help: 'Old help' } }
		})).toThrow(/message catalogue/);
		// uniqueness has one spelling: a named constraint
		expect(() => split_model('notes', {
			description: 'Notes', fields: { code: { kind: 'text', unique: true } }
		})).toThrow();
	});

	it('keeps physical key metadata private to native models and rejects it at the workspace boundary', () => {
		expect(declarations).not.toHaveProperty('bind_system_model');
		for (const table of [{ primary: 'text' }, { primary: 'uuid', identity: 'sequence' }])
			expect(() => split_model('notes', {
				description: 'Notes', fields: { note: { kind: 'text' } }, table
			})).toThrow(/table/);
		const messages = split_system_model(message.name, message.spec).model;
		expect(messages.table).toEqual({ primary: 'text', identity: 'seq' });
		expect(messages.fields['seq']).toEqual({ kind: 'int' });
		expect(messages.fields['created_at']).toMatchObject({ kind: 'instant' });
		expect(split_system_model(configuration.name, configuration.spec).model.table)
			.toEqual({ primary: { field: 'key' } });
		expect(() => split_model(message.name, message.spec)).toThrow(/table/);
	});

	it('lowers canonical JSON array lengths and propagates their actual NULL guarantees', () => {
		const arrays = bind_model('array_lengths')({
			description: 'Array lengths',
			fields: {
				required: { kind: 'json', shape: { kind: 'int', many: true }, default: [] },
				optional: { kind: 'json', shape: { kind: 'int', many: true }, optional: true },
				length: { kind: 'int', computed: { json_length: { field: 'required' } } },
				optional_length: { kind: 'int', computed: { json_length: { field: 'optional' } } },
				plus_one: { kind: 'int', computed: { plus: [{ json_length: { field: 'optional' } }, 1] } },
				safe_length: { kind: 'int', computed: { coalesce: [{ json_length: { field: 'optional' } }, 0] } },
				chosen_length: { kind: 'int', computed: { when: [false, { json_length: { field: 'optional' } }, { json_length: { field: 'required' } }] } }
			}
		});
		const model = split_model(arrays.name, arrays.spec).model;
		expect(model.computed?.['length']?.expr).toEqual({ json_length: { field: 'required' } });
		for (const [name, expected] of [
			['length', false], ['optional_length', true], ['plus_one', true], ['safe_length', false], ['chosen_length', false]
		] as const) {
			const computed = model.computed?.[name];
			if (computed === undefined) throw new Error(`Missing computed field ${name}`);
			expect(nullable_of_expr(computed.expr, model)).toBe(expected);
		}
		expect(nullable_of_expr({ json_length: { field: 'items' } }, {
			fields: { items: { kind: 'json', optional: false } }
		})).toBe(false);
		expect(nullable_of_expr({ json_length: { field: 'items' } }, {
			fields: { items: { kind: 'json', optional: true } }
		})).toBe(true);
	});

	it('keeps a custom field validator with its literal', () => {
		const validate = (value: Parameters<NonNullable<typeof fixtures.rating.check>>[0]) =>
			value.score > 0 ? undefined : 'positive';
		const field = custom_field({
			description: 'Score',
			shape: {
				kind: 'object',
				fields: { score: { kind: 'int', min: 1, max: 5 }, note: { kind: 'text', optional: true } }
			},
			validate
		});
		expect(field.check).toBe(validate);
		expect(field.spec.validate).toBe(validate);
		expect(field.check?.({ score: 0 })).toBe('positive');
	});
});
