import { custom, dateRange, defineModel, numeric, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		leave_code: text().notNull(),
		days: numeric().notNull(),
		authority: text().notNull(),
		owner: custom('accrual_owner').notNull(),
		key: custom('accrual_key').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'Leave entitlement in days for one service band (or flat), owned either by a jurisdiction as the statutory minimum or by a company as its own policy.',
		recordLabel: ['leave_code', 'days'],
		icon: 'lucide:calendar-range',
		// Plan 02 §7 — two-dimensional: owner =, leave_code =, key band &&, effective range &&.
		//
		// `owner` is a variant, so the owning id is COALESCEd out of whichever arm holds it —
		// jurisdiction and company ids are distinct uuids, so the projection identifies the owner
		// on its own.
		//
		// The key band is a POINT range, not an open-ended one: a SERVICE_MONTHS band runs from its
		// `band_from` up to wherever the next band starts, so two bands collide exactly when their
		// `band_from` is equal (this is `keysCollide` in +hooks.ts). Projecting it as
		// `numrange(band_from, NULL)` would make every band overlap every higher one — verified:
		// it rejects a legitimate 0-months + 24-months pair with 23P01. `by` is an equality member
		// so a FLAT band (no `band_from`, hence the unbounded range) does not swallow the
		// service-banded rows.
		exclusions: [
			{
				name: 'accrual_bands_no_overlap',
				elements: [
					{ expr: "COALESCE(owner->>'jurisdiction_id', owner->>'company_id')", with: '=' },
					{ expr: 'leave_code', with: '=' },
					{ expr: "(key->>'by')", with: '=' },
					{
						expr: "numrange((key->>'band_from')::numeric, (key->>'band_from')::numeric, '[]')",
						with: '&&'
					},
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
