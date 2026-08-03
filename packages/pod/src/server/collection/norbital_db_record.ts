import { z } from 'zod';

export const NorbitalDBRecordSchema = z
	.object({
		norbital_id: z.string()
	})
	.passthrough();

export type TNorbitalDBRecord = z.infer<typeof NorbitalDBRecordSchema>;
