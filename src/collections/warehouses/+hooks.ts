import type { Hooks } from './$types.js';

function normalizeCode(code: unknown): string {
	const normalized = String(code ?? '')
		.trim()
		.toUpperCase();
	if (!normalized) throw new Error('Warehouse code is required.');
	return normalized;
}

function normalizeName(name: unknown): string {
	const normalized = String(name ?? '').trim();
	if (!normalized) throw new Error('Warehouse name is required.');
	return normalized;
}

export default {
	create: {
		before: async ({ input }) => {
			return {
				...input,
				code: normalizeCode(input.code),
				name: normalizeName(input.name),
				active: input.active ?? true
			};
		}
	},
	update: {
		before: async ({ input, existing }) => {
			if (input.code != null && input.code !== existing.code) {
				throw new Error('Warehouse code cannot be changed once set.');
			}
			if (input.name != null) normalizeName(input.name);
			return input;
		}
	}
} satisfies Hooks;
