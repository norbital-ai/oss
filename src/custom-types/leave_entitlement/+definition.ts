import { dateRangeZodSchema, defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';
import { accrualKeySchema } from '../accrual_key/+definition.js';

const award = {
	key: accrualKeySchema,
	days: z.number().check(z.minimum(0)),
	authority: z.string().check(z.minLength(1)),
	effective_range: dateRangeZodSchema
} as const;

/** One closed policy layer. A row can never accidentally be statutory and individual at once. */
export const leaveEntitlementLayerSchema = z.discriminatedUnion('level', [
	z.strictObject({ level: z.literal('STATUTORY'), ...award }),
	z.strictObject({ level: z.literal('ORGANISATION'), ...award }),
	z.strictObject({ level: z.literal('EMPLOYEE'), employment_id: z.uuid(), ...award })
]);

export const leaveEntitlementSchema = z.strictObject({
	merge: z.literal('MAX_WITH_STATUTORY_FLOOR'),
	layers: z.array(leaveEntitlementLayerSchema)
});

export type LeaveEntitlement = z.infer<typeof leaveEntitlementSchema>;

export default defineCustomType({ name: 'leave_entitlement', schema: leaveEntitlementSchema });
