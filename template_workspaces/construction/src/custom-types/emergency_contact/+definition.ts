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
	description:
		'A next-of-kin name and phone number with their relationship to the worker, held so site supervision can reach someone after an incident.',
	schema: emergencyContactSchema
});
