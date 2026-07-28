import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export const projectAddressSchema = z
	.object({
		line_1: z.string(),
		line_2: z.string().nullable(),
		city: z.string(),
		state: z.string().nullable(),
		postal_code: z.string(),
		country: z.string()
	})
	.strict();

export default defineCustomType({
	name: 'project_address',
	schema: projectAddressSchema
});
