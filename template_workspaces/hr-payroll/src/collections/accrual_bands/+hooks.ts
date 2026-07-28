import { assertNoOverlap } from '../../lib/effective_range.js';
import { variantField, variantNumber, variantTag } from '../../lib/variant.js';
import type { Hooks } from './$types.js';

/**
 * Exclusion key (plan 02 §7): owner =, leave_code =, **key band &&**, effective range &&.
 *
 * `owner` and `key` are variants, so neither can be a column filter — the candidates are fetched
 * by `leave_code` and narrowed in TypeScript. A `SERVICE_MONTHS` band runs from its `band_from`
 * up to the next band's, so two bands collide exactly when their `band_from` is the same.
 *
 * The database is the guarantee — `accrual_bands_no_overlap` in +model.ts projects the same key out
 * of the JSONB owner and key (the band as a POINT range, so equal `band_from` is the collision) and
 * rejects an overlap with SQLSTATE 23P01 whatever path the write takes, including a concurrent one.
 * This hook is the message: it fails first, names the leave code it clashes on, and reads the
 * variants in TypeScript rather than as SQL projections.
 */
function ownersMatch(a: unknown, b: unknown): boolean {
	const level = variantTag(a, 'level');
	if (level == null || level !== variantTag(b, 'level')) return false;
	const key = level === 'STATUTORY' ? 'jurisdiction_id' : 'company_id';
	return variantField(a, key) === variantField(b, key);
}

function keysCollide(a: unknown, b: unknown): boolean {
	const by = variantTag(a, 'by');
	if (by == null || by !== variantTag(b, 'by')) return false;
	if (by === 'FLAT') return true;
	return variantNumber(a, 'band_from') === variantNumber(b, 'band_from');
}

export default {
	create: {
		before: async ({ input, api }) => {
			const siblings = await api.db.query.accrual_bands.findMany({
				where: { leave_code: { eq: input.leave_code } }
			});
			assertNoOverlap({
				candidate: input.effective_range,
				existing: siblings.filter(
					(row) => ownersMatch(input.owner, row.owner) && keysCollide(input.key, row.key)
				),
				identity: `accrual band for ${input.leave_code}`
			});
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const leave_code = input.leave_code ?? existing.leave_code;
			const owner = input.owner ?? existing.owner;
			const key = input.key ?? existing.key;
			const effective_range = input.effective_range ?? existing.effective_range;
			const siblings = await api.db.query.accrual_bands.findMany({
				where: { leave_code: { eq: leave_code } }
			});
			assertNoOverlap({
				candidate: effective_range,
				existing: siblings.filter(
					(row) => ownersMatch(owner, row.owner) && keysCollide(key, row.key)
				),
				identity: `accrual band for ${leave_code}`,
				excludeId: existing.norbital_id
			});
			return input;
		}
	}
} satisfies Hooks;
