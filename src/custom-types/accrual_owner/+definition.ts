import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * Who owns an accrual band: a jurisdiction (statutory minimum) or a company (its own,
 * more generous, policy). A variant cannot be a foreign key — referential integrity for
 * these ids is checked in `+hooks.ts`, not by a constraint.
 */
export const accrualOwnerSchema = z.discriminatedUnion('level', [
	z.strictObject({ level: z.literal('STATUTORY'), jurisdiction_id: z.uuid() }),
	z.strictObject({ level: z.literal('COMPANY'), company_id: z.uuid() })
]);

export type AccrualOwner = z.infer<typeof accrualOwnerSchema>;

export default defineCustomType({ name: 'accrual_owner', schema: accrualOwnerSchema });
