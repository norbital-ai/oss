// std/pricing (§3.7, M2): catalogue lines → bands → formula → bucket → line. A catalogue line carries ordered bands of
// formula text; a band that holds (`when`) takes a slice of the quantity (`take`, default all that is left) and prices
// it (`price`, reading the slice as the root `quantity`); each priced slice is one line in the catalogue line's bucket.
// Payroll overtime bands, allowance families, CRM price breaks and commissions are all this shape.
import { Decimal, type DecimalLike } from './decimal.ts';
import { compile, evaluate } from './formula.ts';

type Band = { readonly when?: string; readonly take?: string; readonly price: string; readonly label?: string };
type Line = { readonly code: string; readonly label: string; readonly bucket: string; readonly quantity?: DecimalLike | null; readonly bands: readonly Band[] };
type Ctx = Parameters<typeof compile>[0];
type Values = { readonly [root: string]: unknown };
type Amount<C> = C extends { readonly numbers: 'float' } ? number : Decimal;
type Slice<C> = { readonly band: number; readonly label: string | undefined; readonly quantity: Decimal | null; readonly amount: Amount<C> };

/** A priced line: its code, label, bucket and band, the quantity (or `null`) and the amount. */
export type PricedLine<C = Ctx> = {
	readonly code: string; readonly label: string; readonly bucket: string; readonly band: number;
	readonly quantity: Decimal | null; readonly amount: Amount<C>;
};

function run(ctx: Ctx, text: string, result: 'bool' | 'decimal', values: Values): unknown {
	const c = compile(ctx, text, result);
	if ('error' in c) throw new Error(`'${text}' does not compile: ${c.error}`);
	return evaluate(c, values as never);
}
const toDecimal = (v: unknown) => v instanceof Decimal ? v : Decimal.fromNumber(v as number, 10);

/**
 * The slices one band list prices. With no quantity the first band that holds prices the whole (a flat amount);
 * with one, bands take slices in order until it is used up.
 */
export function band<C extends Ctx>(ctx: C, bands: readonly Band[], values: Values, quantity?: DecimalLike | null): Slice<C>[] {
	const holds = (b: Band, q: Decimal | null) => b.when === undefined || run(ctx, b.when, 'bool', { ...values, quantity: q }) === true;
	const price = (b: Band, q: Decimal | null) => run(ctx, b.price, 'decimal', { ...values, quantity: q }) as Amount<C>;
	if (quantity == null) {
		const i = bands.findIndex((b) => holds(b, null));
		return i < 0 ? [] : [{ band: i, label: bands[i]!.label, quantity: null, amount: price(bands[i]!, null) }];
	}
	const out: Slice<C>[] = [];
	let left = Decimal.of(quantity);
	for (const [i, b] of bands.entries()) {
		if (left.sign() <= 0) break;
		if (!holds(b, left)) continue;
		const want = b.take === undefined ? left : toDecimal(run(ctx, b.take, 'decimal', { ...values, quantity: left }));
		const take = want.gt(left) ? left : want;
		if (take.sign() <= 0) continue;
		out.push({ band: i, label: b.label, quantity: take, amount: price(b, take) });
		left = left.minus(take);
	}
	return out;
}

/** Every catalogue line priced through its bands, one `PricedLine` per slice, in catalogue order. */
export function pricedLines<C extends Ctx>(ctx: C, lines: readonly Line[], values: Values): PricedLine<C>[] {
	return lines.flatMap((l) => band(ctx, l.bands, values, l.quantity).map((s) => ({
		code: l.code, label: s.label ?? l.label, bucket: l.bucket, band: s.band, quantity: s.quantity, amount: s.amount
	})));
}
