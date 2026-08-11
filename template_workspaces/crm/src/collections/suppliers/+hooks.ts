import type { Hooks } from './$types.js';

function normalizeCode(code: unknown): string {
	const normalized = String(code ?? '')
		.trim()
		.toUpperCase();
	if (!normalized) throw new Error('Supplier code is required.');
	return normalized;
}

function normalizeName(name: unknown): string {
	const normalized = String(name ?? '').trim();
	if (!normalized) throw new Error('Supplier name is required.');
	return normalized;
}

function validatePaymentTermsDays(value: unknown): void {
	if (value == null) return;
	const days = Number(value);
	if (!Number.isInteger(days) || days < 0 || days > 365) {
		throw new Error('Payment terms must be an integer between 0 and 365 days.');
	}
}

export default {
	create: {
		before: {
			description:
				'Uppercases the supplier code, trims the name, defaults the supplier to active, and rejects payment terms outside 0 to 365 days.',
			handler: async ({ input }) => {
				validatePaymentTermsDays(input.payment_terms_days);
				return {
					...input,
					code: normalizeCode(input.code),
					name: normalizeName(input.name),
					active: input.active ?? true
				};
			}
		}
	},
	update: {
		before: {
			description:
				'Refuses to change a supplier code once it is set and keeps the name and payment terms within range.',
			handler: async ({ input, existing }) => {
				if (input.code != null && input.code !== existing.code) {
					throw new Error('Supplier code cannot be changed once set.');
				}
				if (input.name != null) normalizeName(input.name);
				validatePaymentTermsDays(input.payment_terms_days ?? existing.payment_terms_days);
				return input;
			}
		}
	}
} satisfies Hooks;
