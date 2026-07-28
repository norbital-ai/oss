import { z } from 'zod';

export const idInputSchema = z.object({
	id: z.string()
});

export const noInputSchema = z.object({});

export const pathInputSchema = z.object({
	path: z.string()
});
