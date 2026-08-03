import { roundHalfUp } from '../../lib/pricing.js';
import type { Hooks } from './$types.js';

function todayDateString(): string {
	return new Date().toISOString().slice(0, 10);
}

function hasAtMostTwoDecimalPlaces(value: number): boolean {
	return value === roundHalfUp(value, 2);
}

function validateMarkupPct(value: number): void {
	if (!Number.isFinite(value) || value <= 0 || value > 500) {
		throw new Error('Markup percentage must be a finite number greater than 0 and at most 500.');
	}
	if (!hasAtMostTwoDecimalPlaces(value)) {
		throw new Error('Markup percentage must have at most two decimal places.');
	}
}

function normalizeScope(scope: unknown): string {
	const trimmed = String(scope ?? '')
		.trim()
		.toLowerCase();
	if (!trimmed) throw new Error('Scope is required.');
	return trimmed;
}

export default {
	create: {
		before: async ({ input }) => {
			const scope = normalizeScope(input.scope);
			const markupPct = Number(input.markup_pct);
			validateMarkupPct(markupPct);
			return {
				...input,
				scope,
				markup_pct: markupPct,
				effective_from: input.effective_from ?? todayDateString()
			};
		}
	},
	update: {
		before: async ({ input, existing }) => {
			const resolved = { ...existing, ...input };
			const scope = normalizeScope(resolved.scope);
			const markupPct = Number(resolved.markup_pct);
			validateMarkupPct(markupPct);
			return {
				...input,
				scope,
				markup_pct: markupPct
			};
		}
	}
} satisfies Hooks;
