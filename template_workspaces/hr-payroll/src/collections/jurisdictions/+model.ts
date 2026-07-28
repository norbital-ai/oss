import {
	custom,
	dateRange,
	defineModel,
	enums,
	integer,
	numeric,
	text
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text().notNull(),
		currency: text().notNull(),
		tax_year_start_month: integer().notNull(),
		leave_year_start_month: integer().notNull(),
		proration: custom('proration_basis').notNull(),
		rounding: enums(['NEAREST_CENT', 'TRUNCATE_CENT', 'UP_5_CENTS']).notNull(),
		ordinary_rate_basis: enums(['DAYS_PER_MONTH', 'HOURS_PER_MONTH']).notNull(),
		ordinary_rate_divisor: numeric().notNull(),
		effective_range: dateRange().notNull(),
		definition_hash: text().notNull()
	},
	{
		description:
			'A country or sub-national payroll regime: its currency, year boundaries, proration basis, rounding and ordinary-rate divisor. The only place proration is configured.',
		recordLabel: 'name',
		icon: 'lucide:globe'
	}
);
