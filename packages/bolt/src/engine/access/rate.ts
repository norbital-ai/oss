// Rate limits (rule 38): fixed windows counted first in the serving cell's memory, persisted by acts as a piece of their
// one statement (`bolt_rate`), and loaded in one read when a cell takes a tenant (`OPEN_WINDOWS_SQL`). Client addresses
// are resolved through the trusted-proxy list; IPv6 counts by its /64; an address never reaches a bucket key in plain text.
// Limits charge requests (HTTP acts, reads, uploads, agent posts, sign-in, envoy traffic) and an automation's manual starts
// (its own `limit`, callables/index.ts); cron, webhook and model effect runs and run bodies' acts are never limited.
import { Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { hmacSha256, toBase64url } from '../crypto.ts';
import type { Authority } from '../contracts.ts';

import { duration } from '../runs/time.ts';

/** One bucket an attempt charges: `rule` names the limit (`act`, `session.sendCode`, …), `bucket` whom it counts. */
export type Charge = { rule: string; bucket: string; limit: number; windowMs: number };
type RateVerdict = { ok: true } | { ok: false; retryAfter: number };

/** `'600/min'` → 600 per 60 000 ms; `'1/15min'` → 1 per 900 000 ms. */
export function parseRate(rate: string): { limit: number; windowMs: number } {
	const [n, unit] = rate.split('/') as [string, string];
	return { limit: Number(n), windowMs: duration(/^\d/.test(unit) ? unit : `1${unit}`) };
}
const windowStart = (nowMs: number, windowMs: number) => nowMs - (nowMs % windowMs);
/**
 * A bucket's key within its window: a 53-bit hash (cyrb53) of `rule` and `bucket`, so a bucket costs one number however
 * long its names. At 10 000 open buckets a collision is ~1 in 10^8; it would only share two buckets' counts.
 */
const id = (rule: string, bucket: string): number => {
	let h1 = 0xdeadbeef,
		h2 = 0x41c6ce57;
	const mix = (c: number) => {
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	};
	for (let i = 0; i < rule.length; i++) mix(rule.charCodeAt(i));
	mix(0);
	for (let i = 0; i < bucket.length; i++) mix(bucket.charCodeAt(i));
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
/** Seconds until the last of these windows resets: a persisted refusal's `Retry-After`. */
export const resetAfter = (charges: readonly Charge[], nowMs: number): number =>
	Math.max(
		1,
		...charges.map((c) => Math.ceil((windowStart(nowMs, c.windowMs) + c.windowMs - nowMs) / 1000))
	);
const DAY = 86_400_000;

/**
 * One tenant's open windows in one cell, at most `max` buckets (rule 72). Buckets group by the instant their window
 * starts, each a number key and a small-integer count; a hit only increments. When full, every group whose windows all
 * ended is dropped, then the oldest buckets until half remain, so eviction is amortized O(1). An evicted bucket restarts
 * at 0.
 */
export class RateWindows {
	/** window start → the latest end among its buckets, and each bucket's count */
	private readonly windows = new Map<number, { end: number; counts: Map<number, number> }>();
	private count = 0;
	private readonly max: number;
	constructor(max = 10_000) {
		this.max = max;
	}
	get size(): number {
		return this.count;
	}
	private add(start: number, end: number, k: number, n: number, nowMs: number): number {
		let window = this.windows.get(start);
		const prior = window?.counts.get(k);
		if (prior === undefined) {
			if (this.count >= this.max) {
				this.evict(nowMs);
				window = this.windows.get(start);
			}
			this.count += 1;
		}
		if (window === undefined) {
			window = { end, counts: new Map() };
			this.windows.set(start, window);
		} else if (end > window.end) window.end = end;
		const next = (prior ?? 0) + n;
		window.counts.set(k, next);
		return next;
	}
	/** Increments every bucket, then refuses if any is over: refusals count (rule 38). */
	charge(charges: readonly Charge[], nowMs: number): RateVerdict {
		let retryAfter = 0;
		for (const c of charges) {
			const start = windowStart(nowMs, c.windowMs),
				end = start + c.windowMs;
			if (this.add(start, end, id(c.rule, c.bucket), 1, nowMs) > c.limit)
				retryAfter = Math.max(retryAfter, Math.ceil((end - nowMs) / 1000));
		}
		return retryAfter > 0 ? { ok: false, retryAfter } : { ok: true };
	}
	private evict(nowMs: number): void {
		for (const [start, window] of this.windows)
			if (window.end <= nowMs) {
				this.count -= window.counts.size;
				this.windows.delete(start);
			}
		for (const start of [...this.windows.keys()].sort((a, b) => a - b)) {
			const counts = this.windows.get(start)!.counts;
			for (const k of counts.keys()) {
				if (this.count <= this.max / 2) return;
				counts.delete(k);
				this.count -= 1;
			}
			this.windows.delete(start);
		}
	}
	/** A cell taking a tenant: persisted counts of open windows (`OPEN_WINDOWS_SQL`). */
	load(rows: readonly (typeof OpenWindow.Type)[], nowMs: number): void {
		for (const r of rows) {
			if (this.count >= this.max) return;
			const k = id(r.rule, r.bucket),
				prior = this.windows.get(r.start)?.counts.get(k) ?? 0;
			// a window's length is not stored: it ends within a day, and its next charge sets the real end
			if (r.n > prior) this.add(r.start, r.start + DAY, k, r.n - prior, nowMs);
		}
	}
}
/** One row of `OPEN_WINDOWS_SQL`. */
export const OpenWindow = Schema.Struct({
	rule: Schema.String,
	bucket: Schema.String,
	start: Schema.Number,
	n: Schema.Number
});
/** The one read that loads a tenant's open windows (longest window a limit declares: a day), newest first. */
export const OPEN_WINDOWS_SQL = `SELECT rule, bucket, (extract(epoch FROM window_start) * 1000)::float8 AS start, n FROM bolt_rate WHERE window_start > now() - interval '1 day' ORDER BY window_start DESC LIMIT 10000`;

/**
 * The persisted piece of an act's statement: CTE `rate` upserts every bucket and returns only the ones still under
 * their limit, so `(SELECT count(*) FROM rate) = charges.length` is the gate the rest of the statement conditions on
 * (rule 20's shape: a refused increment still counts, and the act's writes do not happen).
 */
export function ratePiece(
	charges: readonly Charge[],
	nowMs: number,
	param: (v: Json) => string
): { cte: string; admitted: string } {
	if (charges.length === 0) return { cte: 'rate AS (SELECT 1 WHERE false)', admitted: 'true' };
	const rows = charges.map(
		(c) =>
			`(${param(c.rule)}, ${param(c.bucket)}, ${param(new Date(windowStart(nowMs, c.windowMs)).toISOString())}::timestamptz, ${param(c.limit)}::int)`
	);
	return {
		cte: `rate_in(rule, bucket, window_start, lim) AS (VALUES ${rows.join(', ')}),
rate AS (INSERT INTO bolt_rate (rule, bucket, window_start, n) SELECT rule, bucket, window_start, 1 FROM rate_in
	ON CONFLICT (rule, bucket, window_start) DO UPDATE SET n = bolt_rate.n + 1
	RETURNING rule, bucket, window_start, n)`,
		admitted: `((SELECT count(*) FROM rate JOIN rate_in USING (rule, bucket, window_start) WHERE rate.n <= rate_in.lim) = ${charges.length})`
	};
}

// ── addresses ──
/** Dotted-quad IPv4 (no leading zeros, as `node:net` accepts it): its four bytes, else null. */
const ipv4 = (a: string): number[] | null => {
	const parts = a.split('.');
	if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p))) return null;
	const bytes = parts.map(Number);
	return bytes.every((b) => b < 256) ? bytes : null;
};
/** IPv6 text (with `::` and a trailing dotted quad): its eight 16-bit words, else null. */
const ipv6 = (a: string): number[] | null => {
	const halves = a.split('::');
	if (halves.length > 2) return null;
	const words = (part: string, last: boolean): number[] | null => {
		if (part === '') return [];
		const out: number[] = [];
		const groups = part.split(':');
		for (const [i, g] of groups.entries()) {
			const quad = last && i === groups.length - 1 && g.includes('.') ? ipv4(g) : null;
			if (quad !== null) out.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
			else if (/^[0-9a-f]{1,4}$/i.test(g)) out.push(parseInt(g, 16));
			else return null;
		}
		return out;
	};
	const head = words(halves[0]!, halves.length === 1),
		tail = halves.length === 2 ? words(halves[1]!, true) : [];
	if (head === null || tail === null) return null;
	const fill = 8 - head.length - tail.length;
	if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
	return [...head, ...Array<number>(fill).fill(0), ...tail];
};
/** Any address as IPv6 words; IPv4 as its mapped form, so `::ffff:a.b.c.d` matches an IPv4 subnet, as `BlockList` does. */
const ipWords = (a: string): number[] | null => {
	const quad = ipv4(a);
	return quad === null
		? ipv6(a)
		: [0, 0, 0, 0, 0, 0xffff, (quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!];
};
/** The client address: the TCP peer, stepping right to left through X-Forwarded-For while the hop is trusted. */
export function clientAddress(
	peer: string,
	forwardedFor: string | undefined,
	trusted: readonly string[]
): string {
	// a malformed entry trusts nothing
	const subnets = trusted.flatMap((cidr) => {
		const [net, bits] = cidr.split('/') as [string, string | undefined];
		const words = ipWords(net),
			max = ipv4(net) === null ? 128 : 32,
			n = bits === undefined ? max : Number(bits);
		return words === null || !Number.isInteger(n) || n < 0 || n > max
			? []
			: [{ words, bits: n + 128 - max }];
	});
	const isTrusted = (a: string) => {
		const words = ipWords(a);
		return (
			words !== null &&
			subnets.some((s) =>
				words.every((w, i) => {
					const left = Math.min(16, Math.max(0, s.bits - i * 16)),
						mask = (0xffff << (16 - left)) & 0xffff;
					return (w & mask) === (s.words[i]! & mask);
				})
			)
		);
	};
	const hops = (forwardedFor ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	let address = peer;
	while (isTrusted(address) && hops.length > 0) address = hops.pop()!;
	return address;
}
/** An IPv4 address counts as itself, an IPv6 address by its /64 (one host is routinely given a whole /64). */
export function addressBucket(address: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return mapped[1]!;
	const words = ipv6(address);
	if (words === null) return address;
	return `${words
		.slice(0, 4)
		.map((w) => w.toString(16))
		.join(':')}::/64`;
}
/** `HMAC-SHA256(ip_mac, key)`: IP and pre-sign-in address buckets never hold the value (rule 38, §5.13). */
export const macKey = (ipMac: Uint8Array, value: string): string =>
	toBase64url(hmacSha256(ipMac, value));

// ── the buckets of one request ──
export type RateKind =
	'act' | 'read' | 'upload' | 'agent' | 'register' | 'envoys.receive' | 'envoys.unrecognised';
/** Whom `per` counts: resolved by the host before decode (the IP already MAC'd, rule 38). */
type Who = { actor?: string; ip?: string; sender?: string; subject?: string };
/** Every applicable bucket of a request: the kind key and, when named, the callable key (`<c>.<query|action>`). */
export function chargesFor(
	auth: Authority,
	kinds: readonly (RateKind | string)[],
	who: Who
): Charge[] {
	const out: Charge[] = [];
	for (const rule of auth.limits) {
		if (!kinds.includes(rule.key)) continue;
		const bucket = who[rule.per];
		if (bucket === undefined) continue;
		out.push({ rule: `${rule.key}:${rule.rate}:${rule.per}`, bucket, ...parseRate(rule.rate) });
	}
	return out;
}
