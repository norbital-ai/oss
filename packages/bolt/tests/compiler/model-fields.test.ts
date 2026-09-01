import { describe, expect, it } from 'vitest';
import type { PlatformRelationshipsFor } from '../../src/authoring/internals.js';
import type { ModelDeclaration } from '../../src/authoring/models-schema.js';
import {
	boolean,
	cascade,
	custom,
	defineModel,
	enums,
	file,
	geolocation,
	instant,
	integer,
	jsonb,
	numeric,
	phone,
	reference,
	sql,
	text,
	uuid,
	vector
} from '../../src/authoring/index.js';
import {
	collectionCatalogEntry,
	compileWorkspaceAuthoring
} from '../../src/authoring/model-introspection.js';

const compile = (
	models: Readonly<Record<string, ModelDeclaration>>,
	relationships?: unknown
) =>
	compileWorkspaceAuthoring({
		models,
		sourcePaths: Object.fromEntries(
			Object.keys(models).map((name) => [name, `src/collections/${name}/+model.ts`])
		),
		relationships
	});

describe('CompiledAuthoring model truth', () => {
	it('preserves storage and presentation semantics from executed declarations', () => {
		const compiled = compile({
			sample: defineModel(
				{
					title: text({ search: true }).notNull(),
					mobile: phone(),
					status: enums(['open', 'closed']),
					count: integer().notNull(),
					amount: numeric().notNull(),
					active: boolean().notNull(),
					born: instant({ precision: 'day' }),
					idempotency_key: uuid().unique(),
					where: geolocation(),
					photo: file({ mimeTypes: ['image/png'] }),
					attachments: file({ multiple: true }),
					tags: text().array(),
					embedding: vector({ dimensions: 8 }),
					blob: jsonb(),
					pay: custom('money', { allowedCurrencies: ['SGD', 'USD'] }),
					period: custom('instant_range', { precision: 'minute' }),
					source: reference({ TIME_ENTRY: 'time_entries', LEAVE_REQUEST: 'leave_requests' })
				},
				{ recordLabel: ['title', 'status'] }
			)
		});
		const [sample] = compiled.collections;
		if (sample === undefined) throw new Error('sample did not compile');
		const catalog = collectionCatalogEntry(sample, compiled.relationships);

		expect(sample.recordLabel).toBe("title + ' · ' + status");
		expect(sample.fields.title).toMatchObject({
			type: 'string',
			presentationKind: 'text',
			required: true,
			search: true
		});
		expect(sample.fields.idempotency_key).toMatchObject({
			type: 'uuid',
			presentationKind: 'uuid',
			indexed: true,
			unique: true
		});
		expect(
			Object.fromEntries(catalog.fields.map((field) => [field.name, field.kind]))
		).toMatchObject({
			mobile: 'phone',
			status: 'enum',
			count: 'integer',
			amount: 'numeric',
			active: 'boolean',
			born: 'instant',
			where: 'geolocation',
			photo: 'file',
			embedding: 'json',
			blob: 'json',
			pay: 'money',
			period: 'instant_range',
			source: 'reference'
		});
		expect(catalog.fields.find(({ name }) => name === 'status')?.values).toEqual([
			'open',
			'closed'
		]);
		expect(catalog.fields.find(({ name }) => name === 'pay')?.currencies).toEqual([
			'SGD',
			'USD'
		]);
		expect(catalog.fields.find(({ name }) => name === 'period')?.precision).toBe('minute');
		expect(catalog.fields.find(({ name }) => name === 'photo')?.mimeTypes).toEqual([
			'image/png'
		]);
		expect(catalog.fields.find(({ name }) => name === 'attachments')?.array).toBe(true);
		expect(sample.fields.tags).toMatchObject({ array: true, sqlType: 'text[]' });
		expect(catalog.fields.find(({ name }) => name === 'tags')?.array).toBe(true);
		expect(compiled.customTypeReferences).toEqual([
			{ collection: 'sample', field: 'pay', name: 'money' },
			{ collection: 'sample', field: 'period', name: 'instant_range' }
		]);
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Object.isFrozen(sample.fields)).toBe(true);
	});

	it('marks generated columns read-only without leaking flags across fields', () => {
		const compiled = compile({
			pay_components: defineModel({
				name: text({ search: true }).notNull(),
				nature: text().generatedAlwaysAs(sql`upper("name")`).notNull(),
				sequence: integer().notNull()
			})
		});
		const collection = compiled.collections[0];
		if (collection === undefined) throw new Error('pay_components did not compile');
		const byName = new Map(
			collectionCatalogEntry(collection, []).fields.map((field) => [field.name, field])
		);

		expect(byName.get('name')).toMatchObject({ nullable: false, search: true });
		expect(byName.get('name')).not.toHaveProperty('readOnly');
		expect(collection.fields.nature).toMatchObject({
			required: false,
			databaseNotNull: true
		});
		expect(byName.get('nature')).toMatchObject({ nullable: true, readOnly: true });
		expect(byName.get('sequence')).toMatchObject({ nullable: false });
	});
});

describe('CompiledAuthoring relationship truth', () => {
	const models = {
		employees: defineModel({ name: text().notNull() }),
		employments: defineModel({ employee_id: uuid().notNull() })
	};
	const relationships = ((r) => ({
		employees: { employments: r.many.employments() },
		employments: {
			employee: cascade(
				r.one.employees({ from: r.employments.employee_id, to: r.employees.id })
			)
		}
	})) satisfies PlatformRelationshipsFor<typeof models>;

	it('executes declarations and resolves inverse endpoints and cascade once', () => {
		const compiled = compile(models, relationships);
		expect(compiled.relationships).toEqual([
			{
				name: 'employments',
				source: 'employees',
				target: 'employments',
				cardinality: 'many',
				cascade: true,
				from: { collection: 'employees', column: 'id' },
				to: { collection: 'employments', column: 'employee_id' }
			},
			{
				name: 'employee',
				source: 'employments',
				target: 'employees',
				cardinality: 'one',
				cascade: true,
				from: { collection: 'employments', column: 'employee_id' },
				to: { collection: 'employees', column: 'id' }
			}
		]);
		const employment = compiled.collections.find(({ name }) => name === 'employments');
		if (employment === undefined) throw new Error('employments did not compile');
		expect(
			collectionCatalogEntry(employment, compiled.relationships).fields[0]?.relation
		).toEqual({ name: 'employee', target: 'employees', cardinality: 'one' });
	});

	it('refuses ambiguous inverse endpoints instead of guessing', () => {
		const ambiguousModels = {
			people: defineModel({ name: text() }),
			links: defineModel({ from_id: uuid(), to_id: uuid() })
		};
		const ambiguous = ((r) => ({
			people: { links: r.many.links() },
			links: {
				from: r.one.people({ from: r.links.from_id, to: r.people.id }),
				to: r.one.people({ from: r.links.to_id, to: r.people.id })
			}
		})) satisfies PlatformRelationshipsFor<typeof ambiguousModels>;
		expect(() => compile(ambiguousModels, ambiguous)).toThrow('ambiguous inverse endpoints');
	});

	it('refuses an endpointless relationship with no inverse', () => {
		const unresolved = ((r) => ({
			employees: { employments: r.many.employments() },
			employments: {}
		})) satisfies PlatformRelationshipsFor<typeof models>;

		expect(() => compile(models, unresolved)).toThrow('no resolvable inverse');
	});

	it('refuses relationship targets absent from the compiled models', () => {
		type OpenHelpers = {
			readonly one: {
				readonly [name: string]:
					| ((input?: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>)
					| undefined;
			};
			readonly many: {
				readonly [name: string]:
					| ((input?: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>)
					| undefined;
			};
			readonly employees: { readonly id: unknown };
			readonly employments: { readonly employee_id: unknown };
			readonly missing: { readonly id: unknown };
		};
		const invalid = (r: OpenHelpers) => {
			const missing = r.one.missing;
			if (missing === undefined) throw new TypeError('unknown target missing');
			const employments = r.many.employments;
			if (employments === undefined) throw new TypeError('unknown target missing');
			return {
				employees: {
					employments: employments({
						from: r.employments.employee_id,
						to: r.employees.id
					})
				},
				employments: {
					employee: missing({ from: r.employments.employee_id, to: r.missing.id })
				}
			};
		};

		expect(() => compile(models, invalid)).toThrow('unknown target missing');
	});
});
