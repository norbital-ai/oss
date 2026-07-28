/**
 * Money rounding.
 *
 * The calculation runs on IEEE doubles, exactly as the engine this one replaces did. Float error is
 * managed by adding a compensating epsilon before every `round`/`trunc`/`ceil` rather than by a
 * decimal library: the two disagree on genuine ties, and this data is full of them (a SOCSO band
 * midpoint of 4,650 × 1.75% is exactly 81.375). Swapping in decimals would move cents silently, so
 * the epsilon is load-bearing and deliberate — see decision E35.
 */

/**
 * Every rounding token the engine executes. `jurisdictions.rounding` carries the first three money
 * modes; `statutory_contributions.rounding` carries `NONE`, `NEAREST_CENT`, `UP_TO_UNIT` and
 * `TABLE`. `NEAREST_UNIT` and `FLOOR_UNIT` are used by paired-share statutory contracts such as
 * Singapore CPF.
 */
export type RoundingMethod =
	| 'NONE'
	| 'NEAREST_CENT'
	| 'NEAREST_5_CENTS'
	| 'TRUNCATE_CENT'
	| 'UP_5_CENTS'
	| 'NEAREST_UNIT'
	| 'FLOOR_UNIT'
	| 'UP_TO_UNIT'
	| 'TABLE';

function epsilon(value: number): number {
	return Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
}

/**
 * Round a money value.
 *
 * `TABLE` is the identity: a tabled statutory amount is the published figure and is returned
 * verbatim — rounding it would move every SOCSO and EIS employer share by a cent or two (E3, E12).
 * `UP_TO_UNIT` is EPF's "round up to the next ringgit", applied to each share independently.
 */
export function roundMoney(value: number, method: RoundingMethod): number {
	if (!Number.isFinite(value)) throw new Error('Cannot round a non-finite amount.');
	const eps = epsilon(value);
	switch (method) {
		case 'NONE':
		case 'TABLE':
			return value;
		case 'NEAREST_CENT':
			return Math.round((value + eps) * 100) / 100;
		case 'NEAREST_5_CENTS':
			return Math.round((value + eps) * 20) / 20;
		case 'TRUNCATE_CENT':
			return Math.trunc(value * 100 + (value < 0 ? -eps : eps)) / 100;
		case 'UP_5_CENTS':
			return Math.ceil(value * 20 - eps) / 20;
		case 'NEAREST_UNIT':
			return Math.round(value + eps);
		case 'FLOOR_UNIT':
			return Math.floor(value + eps);
		case 'UP_TO_UNIT':
			return Math.ceil(value - eps);
	}
}

/** `round(x, NEAREST_CENT)`, the shape most call sites want. */
export function cents(value: number): number {
	return roundMoney(value, 'NEAREST_CENT');
}

/**
 * Round a day count to the nearest half day, half **up** at the 0.25 boundary — the plan's own
 * worked accrual, 21 × 3 / 12 = 5.25, must land on 5.5 (decision E8/L1).
 */
export function roundHalfDay(value: number): number {
	return Math.round((value + epsilon(value)) * 2) / 2;
}

/**
 * Floor an hour count to the half hour below it. 3.25 h earns 3.0 h, 0.4 h earns nothing at all.
 * There is no one-hour minimum: the plan proposes one, the engine of record has never had it, and
 * introducing it would convert every sub-hour overrun from nothing to a full hour (E4).
 */
export function floorHalfHour(hours: number): number {
	return Math.floor(hours * 2 + epsilon(hours)) / 2;
}
