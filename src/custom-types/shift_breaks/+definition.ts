import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

export const shiftBreakSchema = z.strictObject({
	start: z.string(),
	end: z.string(),
	paid: z.boolean()
});

export const shiftBreaksSchema = z.array(shiftBreakSchema);

export default defineCustomType({ name: 'shift_breaks', schema: shiftBreaksSchema });
