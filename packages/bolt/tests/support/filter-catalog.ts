import type { ModelExposure } from '../../../ui/src/kinds/context.ts';
import type { Offer, Op, FilterStep } from '../../../ui/src/filter/filter.ts';

// The browser test's synthetic catalogue: it exercises field-type rendering, not which paths the live engine offers.
export const filterCatalog: Record<string, ModelExposure> = {
	people: {
		label: ['name'],
		fields: {
			name: { kind: 'text' },
			alias: { kind: 'text' },
			hired: { kind: 'date', optional: true },
			due: { kind: 'date' },
			window: { kind: 'period', of: 'date' },
			enabled: { kind: 'bool' },
			amount: { kind: 'number' },
			sequence: { kind: 'seq' },
			profile: { kind: 'json', shape: { kind: 'object', fields: { city: { kind: 'text' } } } }
		},
		relations: { employer: { targets: ['companies'] } },
		many: ['contracts', 'notes']
	},
	companies: { label: ['name'], fields: { name: { kind: 'text' } } },
	contracts: {
		label: ['alias'],
		fields: {
			alias: { kind: 'text' },
			active: { kind: 'bool' },
			status: { kind: 'enum', values: ['active', 'on_leave', 'ended'] },
			starts: { kind: 'date' },
			ends: { kind: 'date' },
			window: { kind: 'period', of: 'date' },
			amount: { kind: 'number' }
		},
		relations: { person: { targets: ['people'], inverse: 'contracts' } }
	},
	notes: {
		label: ['body'],
		fields: { body: { kind: 'text' } },
		relations: { person: { targets: ['people'], inverse: 'notes' } }
	}
};
const operators: Record<string, Op[]> = {
	text: ['eq', 'ne', 'like', 'in', 'nin'],
	enum: ['eq', 'ne', 'in', 'nin'],
	date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'during'],
	period: ['contains', 'overlaps', 'within', 'startsWithin', 'endsWithin'],
	bool: ['eq'],
	number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'],
	seq: ['eq', 'ne', 'in', 'nin'],
	json: ['contains']
};
const words: Partial<Record<Op, string>> = {
	eq: 'is',
	ne: 'is not',
	like: 'contains',
	contains: 'in force on',
	overlaps: 'overlaps',
	gt: 'after',
	lt: 'before',
	during: 'is within'
};
const fields = (model: string, prefix: FilterStep[]): Offer[] =>
	Object.entries(filterCatalog[model]?.fields ?? {}).flatMap(([name, kind]) =>
		(operators[kind.kind] ?? []).map((op) => ({
			label: name,
			path: [...prefix, { k: 'field' as const, name }],
			op,
			opLabel: words[op] ?? op,
			kind: kind.kind,
			...(op === 'during'
				? {
						values: [
							{ label: 'October 2026', arg: { range: ['2026-10-01', '2026-11-01'] as const } }
						]
					}
				: {})
		}))
	);
export const filterOffers: Offer[] = [
	...fields('people', []),
	...(['eq', 'ne', 'in', 'nin'] as const).map((op) => ({
		label: 'Employer',
		path: [{ k: 'is' as const, rel: 'employer' }],
		op,
		opLabel: words[op] ?? op,
		kind: 'id'
	})),
	...fields('companies', [{ k: 'is', rel: 'employer' }]),
	...(['some', 'none', 'every'] as const).flatMap((q) => [
		...fields('contracts', [{ k: q, rel: 'contracts' }]),
		...fields('notes', [{ k: q, rel: 'notes' }])
	]),
	...(['gte', 'lt'] as const).flatMap((op): Offer[] => [
		{
			label: 'Contracts count',
			path: [{ k: 'count', rel: 'contracts' }],
			op,
			opLabel: op,
			kind: 'int'
		},
		...(['sum', 'min', 'max'] as const).flatMap((fn) =>
			(fn === 'sum' ? ['amount'] : ['amount', 'ends']).map((of): Offer => ({
				label: `Contracts ${fn} ${of}`,
				path: [{ k: 'agg', rel: 'contracts', fn, of }],
				op,
				opLabel: op,
				kind: of === 'ends' ? 'date' : 'number'
			}))
		)
	])
];
