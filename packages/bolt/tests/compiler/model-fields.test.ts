import { describe, expect, it } from 'vitest';
import {
	extractCollectionCatalog,
	extractModelFields,
	extractRelationships
} from '../../src/compiler/model-fields.js';

describe('extractModelFields', () => {
	it('reads builder types and notNull from an authored model', () => {
		const fields = extractModelFields(`
import { defineModel, instant, integer, reference, text } from '@norbital-ai/bolt/authoring';

export default defineModel({
	name: text({ search: true }).notNull(),
date_of_birth: instant({ precision: 'day' }),
	dependents_count: integer().notNull().default(0),
	source: reference({ TIME_ENTRY: 'time_entries', LEAVE_REQUEST: 'leave_requests' }).notNull()
});
`);
		expect(fields).toEqual({
			name: { type: 'string', required: true, indexed: false },
			date_of_birth: { type: 'instant', required: false, indexed: false },
			dependents_count: { type: 'number', required: true, indexed: false },
			source: { type: 'reference', required: true, indexed: false }
		});
	});

	it('preserves primary-key and unique constraints for the schema plan', () => {
		const fields = extractModelFields(`
export default defineModel({
	id: uuid().primaryKey(),
	singleton: boolean().notNull().default(true).unique(),
	sequence: bigint({ mode: 'number' }).notNull().default(0)
});
`);
		expect(fields['id']).toMatchObject({ indexed: true, primaryKey: true });
		expect(fields['singleton']).toMatchObject({ indexed: true, unique: true });
		expect(fields['sequence']).toMatchObject({ indexed: false });
	});

	it('reads one and many relationships including inverse foreign keys', () => {
		const relations = extractRelationships(`
export default ((r) => ({
	employees: {
		employment_employee: r.many.employments()
	},

	employments: {
		employment_employee: r.one.employees({
			from: r.employments.employee_id,
			to: r.employees.id
		}),
		employment_company: r.one.companies({
			from: r.employments.company_id,
			to: r.companies.id
		})
	}
})) satisfies Relationships;
`);
		expect(relations).toEqual([
			{
				name: 'employment_employee',
				source: 'employees',
				target: 'employments',
				cardinality: 'many',
				from: { collection: 'employments', column: 'employee_id' },
				to: { collection: 'employees', column: 'id' }
			},
			{
				name: 'employment_employee',
				source: 'employments',
				target: 'employees',
				cardinality: 'one',
				from: { collection: 'employments', column: 'employee_id' },
				to: { collection: 'employees', column: 'id' }
			},
			{
				name: 'employment_company',
				source: 'employments',
				target: 'companies',
				cardinality: 'one',
				from: { collection: 'employments', column: 'company_id' },
				to: { collection: 'companies', column: 'id' }
			}
		]);
	});

	it('resolves a many edge from a uniquely reversed one even when their names differ', () => {
		const relations = extractRelationships(`
export default ((r) => ({
	accounts: {
		account_contacts: r.many.contacts()
	},
	contacts: {
		contact_account: r.one.accounts({
			from: r.contacts.account_id,
			to: r.accounts.id
		})
	}
})) satisfies Relationships;
`);
		expect(relations[0]).toMatchObject({
			name: 'account_contacts',
			from: { collection: 'contacts', column: 'account_id' },
			to: { collection: 'accounts', column: 'id' }
		});
	});

	it('leaves a many edge unresolved when two inverse foreign keys are possible', () => {
		const relations = extractRelationships(`
export default ((r) => ({
	people: {
		people_links: r.many.links()
	},
	links: {
		link_from: r.one.people({ from: r.links.from_id, to: r.people.id }),
		link_to: r.one.people({ from: r.links.to_id, to: r.people.id })
	}
})) satisfies Relationships;
`);
		expect(relations[0]).not.toHaveProperty('from');
		expect(relations[0]).not.toHaveProperty('to');
	});

	it('builds CollectionTable catalog fields and relations', () => {
		const source = `
export default defineModel(
	{
		name: text({ search: true }).notNull(),
		gender: enums(['MALE', 'FEMALE']),
		dependents_count: integer().notNull().default(0)
	},
	{ recordLabel: 'name' }
);
`;
		const catalog = extractCollectionCatalog('employees', source, [
			{
				name: 'employment_employee',
				source: 'employees',
				target: 'employments',
				cardinality: 'many'
			}
		]);
		expect(catalog).toEqual({
			name: 'employees',
			recordLabel: 'name',
			fields: [
				{ name: 'name', kind: 'text', nullable: false, search: true },
				{ name: 'gender', kind: 'enum', nullable: true, values: ['MALE', 'FEMALE'] },
				{ name: 'dependents_count', kind: 'integer', nullable: false }
			],
			relationships: [{ name: 'employment_employee', target: 'employments', cardinality: 'many' }]
		});
	});

	it('does not infer a field relation from an inherited inverse edge', () => {
		const catalog = extractCollectionCatalog(
			'employments',
			`export default defineModel({
				employee_id: uuid().notNull()
			});`,
			[
				{
					name: 'employment_employee',
					source: 'employees',
					target: 'employments',
					cardinality: 'many',
					from: { collection: 'employments', column: 'employee_id' },
					to: { collection: 'employees', column: 'id' }
				}
			]
		);
		expect(catalog.fields[0]).not.toHaveProperty('relation');
	});
});

describe('field windows', () => {
	// A JSDoc block between two fields used to defeat the window boundary, so flags were read from a
	// later declaration: `nature` has no `.notNull()` yet was published to the client as required,
	// because its window reached `sequence: integer().notNull()`.
	const source = `export default defineModel({
		name: text({ search: true }).notNull(),
		/**
		 * A comment long enough to matter.
		 */
		policy: custom('pay_component_policy').notNull(),
		/** Read-only projection. */
		nature: text().generatedAlwaysAs(sql\`policy ->> 'kind'\`),
		sequence: integer().notNull()
	});`;

	it("does not read a later field's notNull across a comment", () => {
		const fields = extractCollectionCatalog('pay_components', source, []);
		const byName = new Map(fields.fields.map((entry) => [entry.name, entry]));
		expect(byName.get('nature')?.nullable).toBe(true);
		expect(byName.get('policy')?.nullable).toBe(false);
		expect(byName.get('sequence')?.nullable).toBe(false);
	});

	it('marks only the generated column read-only', () => {
		const byName = new Map(
			extractCollectionCatalog('pay_components', source, []).fields.map((e) => [e.name, e])
		);
		expect(byName.get('nature')?.readOnly).toBe(true);
		// The fault the corrected boundary prevents: these sit before the generated column.
		expect(byName.get('name')).not.toHaveProperty('readOnly');
		expect(byName.get('policy')).not.toHaveProperty('readOnly');
	});

	it('keeps a flag on the field that declares it', () => {
		const fields = extractCollectionCatalog('pay_components', source, []);
		const byName = new Map(fields.fields.map((entry) => [entry.name, entry]));
		expect(byName.get('name')?.search).toBe(true);
		// `search` belongs to `name` alone; it must not bleed onto the fields after it.
		expect(byName.get('policy')).not.toHaveProperty('search');
		expect(byName.get('nature')).not.toHaveProperty('search');
	});

	it('reports the same nullability through the model field reader', () => {
		const fields = extractModelFields(source);
		expect(fields['nature']?.required).toBe(false);
		expect(fields['sequence']?.required).toBe(true);
	});
});

describe('built-in catalog kinds', () => {
	it('publishes every built-in column builder as the UI renderer kind', () => {
		const catalog = extractCollectionCatalog(
			'sample',
			`export default defineModel({
				title: text().notNull(),
				mobile: phone(),
				status: enums(['open', 'closed']),
				count: integer().notNull(),
				amount: numeric().notNull(),
				active: boolean().notNull(),
				born: instant({ precision: 'day' }),
				occurred_at: instant(),
				id: uuid(),
				starts: custom('instant_range'),
				period: custom('instant_range').notNull(),
				where: geolocation(),
				photo: file(),
				embedding: vector({ dimensions: 8 }),
				blob: jsonb(),
				pay: custom('money'),
				source: reference({ TIME_ENTRY: 'time_entries', LEAVE_REQUEST: 'leave_requests' })
			});`,
			[]
		);
		expect(Object.fromEntries(catalog.fields.map((entry) => [entry.name, entry.kind]))).toEqual({
			title: 'text',
			mobile: 'phone',
			status: 'enum',
			count: 'integer',
			amount: 'numeric',
			active: 'boolean',
			born: 'instant',
			occurred_at: 'instant',
			id: 'uuid',
			starts: 'instant_range',
			period: 'instant_range',
			where: 'geolocation',
			photo: 'file',
			embedding: 'json',
			blob: 'json',
			pay: 'money',
			source: 'reference'
		});
		expect(catalog.fields.find((field) => field.name === 'born')?.precision).toBe('day');
		expect(catalog.fields.find((field) => field.name === 'occurred_at')).not.toHaveProperty(
			'precision'
		);
	});
});

describe('custom column kinds', () => {
	it('keys a custom column by the type it declares', () => {
		// The renderer registry resolves by kind. Keying every custom column as "custom" would mean
		// all of them rendering through whichever renderer registered last.
		const catalog = extractCollectionCatalog(
			'leave_requests',
			`export default defineModel({
				event: custom('leave_event').notNull(),
				pay: custom('money'),
				note: text()
			});`,
			[]
		);
		const byName = new Map(catalog.fields.map((entry) => [entry.name, entry.kind]));
		expect(byName.get('event')).toBe('leave_event');
		expect(byName.get('pay')).toBe('money');
		expect(byName.get('note')).toBe('text');
	});
});
