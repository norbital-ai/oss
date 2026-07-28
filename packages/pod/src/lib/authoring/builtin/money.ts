import { z } from 'zod';

export { ISO_CURRENCY, type TISOCurrencyCode } from '@norbital-ai/std/finance';

export const moneyZodSchema = z.object({
	value: z.number(),
	currency: z.string()
});

export type MoneyZod = z.infer<typeof moneyZodSchema>;
export type TMoney = MoneyZod;
