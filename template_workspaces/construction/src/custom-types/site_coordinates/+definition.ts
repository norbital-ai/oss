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
	description:
		'An x, y, and z point in the site model, used to place a location or defect inside the building rather than on a map, with any axis that was never surveyed left empty.',
	schema: siteCoordinatesSchema
});
