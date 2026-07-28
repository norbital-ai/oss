import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export const siteCoordinatesSchema = z
	.object({
		x: z.number().nullable(),
		y: z.number().nullable(),
		z: z.number().nullable()
	})
	.strict();

export default defineCustomType({
	name: 'site_coordinates',
	schema: siteCoordinatesSchema
});
