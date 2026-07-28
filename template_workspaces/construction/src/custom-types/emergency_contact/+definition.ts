import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export const emergencyContactSchema = z
	.object({
		name: z.string(),
		phone: z.string(),
		relationship: z.string().nullable()
	})
	.strict();

export default defineCustomType({
	name: 'emergency_contact',
	schema: emergencyContactSchema
});
