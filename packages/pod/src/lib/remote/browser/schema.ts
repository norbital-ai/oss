import { z } from 'zod';

export const BrowserInputSchema = z.object({
	url: z.string(),
	method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.string().optional()
});
