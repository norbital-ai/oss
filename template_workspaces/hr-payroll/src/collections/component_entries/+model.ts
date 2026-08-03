import {
	custom,
	date,
	defineModel,
	integer,
	numeric,
	sql,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		pay_component_id: uuid().notNull(),
		amount: numeric().notNull(),
		quantity: numeric(),
		event_date: date().notNull(),
		pay_period: text(),
		/**
		 * Human-readable provenance — where this amount came from in the source the customer
		 * recognises ("Source MLCLM row 30"), free text, never parsed. Distinct from `origin`,
		 * which is the machine-readable reason the entry exists.
		 */
		description: text(),
		origin: custom('entry_origin').notNull(),
		usage_mode: text().generatedAlwaysAs(
			sql`CASE WHEN origin ->> 'kind' = 'RECURRING' THEN 'RECURRING' ELSE 'SINGLE_USE' END`
		),
		/**
		 * Read-only relational projections of the LOAN_INSTALMENT provenance arm. Keeping the discriminated
		 * union as the source of truth preserves the audit trail; generated columns make its stable keys
		 * available to foreign keys and nested queries without a second writable copy.
		 */
		repayment_agreement_id: uuid().generatedAlwaysAs(
			sql`CASE WHEN origin ->> 'kind' = 'LOAN_INSTALMENT' THEN (origin ->> 'agreement_id')::uuid END`
		),
		repayment_sequence: integer().generatedAlwaysAs(
			sql`CASE WHEN origin ->> 'kind' = 'LOAN_INSTALMENT' THEN (origin ->> 'sequence')::integer END`
		)
	},
	{
		description:
			'The only door money enters payroll through. amount is always a magnitude; direction comes from the pay component policy and a reversal is an origin of kind REVERSAL, never a negative number.',
		recordLabel: ['event_date', 'amount'],
		icon: 'lucide:banknote',
		indexes: [
			// Payslip lines reference this key, not just the entry id. That makes it impossible for a
			// line to claim a different pay component or recurrence mode from the entry it consumes.
			{ columns: ['norbital_id', 'pay_component_id', 'usage_mode'], unique: true },
			{ columns: ['employment_id', 'pay_period'] },
			{ columns: ['pay_component_id'] },
			{
				columns: ['repayment_agreement_id'],
				where: '"repayment_agreement_id" IS NOT NULL'
			}
		]
	}
);
