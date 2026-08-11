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
	description:
		'A postal address for a project, broken into street lines, city, state, postal code, and country so it can be sorted and posted to rather than parsed out of one free-text line.',
	schema: projectAddressSchema
});
