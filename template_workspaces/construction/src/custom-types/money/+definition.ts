import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export interface MoneyOptions {
	readonly allowedCurrencies?: readonly [string, ...string[]];
}

const moneyValueSchema = {
	value: z.number().finite(),
	currency: z
		.string()
		.trim()
		.regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 code.')
};

export default defineCustomType({
	name: 'money',
	description:
		'A monetary amount stored with its ISO 4217 currency code, so claim and contract totals can never silently mix currencies.',
	schema: (options: MoneyOptions = {}) =>
		z
			.object({
				...moneyValueSchema,
				currency: options.allowedCurrencies
					? z.enum(options.allowedCurrencies)
					: moneyValueSchema.currency
			})
			.strict()
});
