import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * Per-rule amounts produced by `SPECIAL` contribution treatments, keyed by the rule name
 * declared on `statutory_contributions.special_rules`. Empty object when no special rule
 * applied to this payslip.
 */
export const specialAmountsSchema = z.record(z.string().check(z.minLength(1)), z.number());

export type SpecialAmounts = z.infer<typeof specialAmountsSchema>;

export default defineCustomType({ name: 'special_amounts', schema: specialAmountsSchema });
