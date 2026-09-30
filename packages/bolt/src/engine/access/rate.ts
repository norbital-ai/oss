// Rate limits (rule 38): fixed windows counted first in the serving cell's memory, persisted by acts as a piece of their
// one statement (`bolt_rate`), and loaded in one read when a cell takes a tenant. Client addresses are resolved through
// the trusted-proxy list; IPv6 counts by its /64; an address never reaches a bucket key in plain text.
import { createHmac } from 'node:crypto';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Json } from '../../decl/values.ts';
import type { Authority, LimitRule } from '../contracts.ts';
import { durationMs } from './pred.ts';

/** One bucket an attempt charges: `rule` names the limit (`act`, `session.sendCode`, …), `bucket` whom it counts. */
export type Charge = { rule: string; bucket: string; limit: number; windowMs: number };
export type RateVerdict = { ok: true } | { ok: false; retryAfter: number };

/** `'600/min'` → 600 per 60 000 ms; `'1/15min'` → 1 per 900 000 ms. */
export function parseRate(rate: string): { limit: number; windowMs: number } {
	const [n, unit] = rate.split('/') as [string, string];
	return { limit: Number(n), windowMs: durationMs(/^\d/.test(unit) ? unit : `1${unit}`) };
}
const windowStart = (nowMs: number, windowMs: number) => nowMs - (nowMs % windowMs);
const id = (c: Charge, start: number) => `${c.rule}\u0000${c.bucket}\u0000${start}`;

/** One tenant's open windows in one cell. At most `max` buckets; the least recently used is evicted (rule 72). */
export class RateWindows {
	private readonly counts = new Map<string, number>();
	private readonly max: number;
	constructor(max = 10_000) { this.max = max; }
	/** Increments every bucket, then refuses if any is over: refusals count (rule 38). */
	charge(charges: readonly Charge[], nowMs: number): RateVerdict {
		let retryAfter = 0;
		for (const c of charges) {
			const start = windowStart(nowMs, c.windowMs), k = id(c, start);
			const n = (this.counts.get(k) ?? 0) + 1;
			this.counts.delete(k);
			this.counts.set(k, n);
			if (n > c.limit) retryAfter = Math.max(retryAfter, Math.ceil((start + c.windowMs - nowMs) / 1000));
		}
		while (this.counts.size > this.max) this.counts.delete(this.counts.keys().next().value!);
		return retryAfter > 0 ? { ok: false, retryAfter } : { ok: true };
	}
	/** A cell taking a tenant: persisted counts of open windows. An evicted bucket restarts here too. */
	load(rows: readonly { rule: string; bucket: string; window_start: string; n: number }[]): void {
		for (const r of rows) {
			const k = `${r.rule}\u0000${r.bucket}\u0000${Date.parse(r.window_start)}`;
			this.counts.set(k, Math.max(this.counts.get(k) ?? 0, Number(r.n)));
		}
	}
}
/** The one read that loads a tenant's open windows (longest window a limit declares: a day). */
export const OPEN_WINDOWS_SQL = `SELECT rule, bucket, window_start, n FROM bolt_rate WHERE window_start > now() - interval '1 day'`;

/**
 * The persisted piece of an act's statement: CTE `rate` upserts every bucket and returns only the ones still under
 * their limit, so `(SELECT count(*) FROM rate) = charges.length` is the gate the rest of the statement conditions on
 * (rule 20's shape: a refused increment still counts, and the act's writes do not happen).
 */
export function ratePiece(charges: readonly Charge[], nowMs: number, param: (v: Json) => string): { cte: string; admitted: string } {
	if (charges.length === 0) return { cte: 'rate AS (SELECT 1 WHERE false)', admitted: 'true' };
	const rows = charges.map((c) => `(${param(c.rule)}, ${param(c.bucket)}, ${param(new Date(windowStart(nowMs, c.windowMs)).toISOString())}::timestamptz, ${param(c.limit)}::int)`);
	return {
		cte: `rate_in(rule, bucket, window_start, lim) AS (VALUES ${rows.join(', ')}),
rate AS (INSERT INTO bolt_rate (rule, bucket, window_start, n) SELECT rule, bucket, window_start, 1 FROM rate_in
	ON CONFLICT (rule, bucket, window_start) DO UPDATE SET n = bolt_rate.n + 1
	RETURNING rule, bucket, window_start, n)`,
		admitted: `((SELECT count(*) FROM rate JOIN rate_in USING (rule, bucket, window_start) WHERE rate.n <= rate_in.lim) = ${charges.length})`,
	};
}

// ── addresses ──
/** The client address: the TCP peer, stepping right to left through X-Forwarded-For while the hop is trusted. */
export function clientAddress(peer: string, forwardedFor: string | undefined, trusted: readonly string[]): string {
	const list = new BlockList();
	for (const cidr of trusted) {
		const [net, bits] = cidr.split('/') as [string, string | undefined];
		const type = isIPv6(net) ? 'ipv6' : 'ipv4';
		list.addSubnet(net, Number(bits ?? (type === 'ipv6' ? 128 : 32)), type);
	}
	const isTrusted = (a: string) => (isIPv4(a) || isIPv6(a)) && list.check(a, isIPv6(a) ? 'ipv6' : 'ipv4');
	const hops = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
	let address = peer;
	while (isTrusted(address) && hops.length > 0) address = hops.pop()!;
	return address;
}
/** An IPv4 address counts as itself, an IPv6 address by its /64 (one host is routinely given a whole /64). */
export function addressBucket(address: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return mapped[1]!;
	if (!isIPv6(address)) return address;
	const [head, tail = ''] = address.split('::') as [string, string?];
	const h = head === '' ? [] : head.split(':'), t = tail === '' ? [] : tail.split(':');
	const full = address.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
	return `${full.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(':')}::/64`;
}
/** `HMAC-SHA256(ip_mac, key)`: IP and pre-sign-in address buckets never hold the value (rule 38, §5.13). */
export const macKey = (ipMac: Uint8Array, value: string): string => createHmac('sha256', ipMac).update(value).digest('base64url');

// ── the buckets of one request ──
export type RateKind = 'act' | 'read' | 'upload' | 'agent' | 'register' | 'envoys.receive' | 'envoys.unrecognised';
/** Whom `per` counts: resolved by the host before decode (the IP already MAC'd, rule 38). */
export type Who = { actor?: string; ip?: string; sender?: string; subject?: string };
/** Every applicable bucket of a request: the kind key and, when named, the callable key (`<c>.<query|action>`). */
export function chargesFor(auth: Authority, kinds: readonly (RateKind | string)[], who: Who): Charge[] {
	const out: Charge[] = [];
	for (const rule of auth.limits as readonly LimitRule[]) {
		if (!kinds.includes(rule.key)) continue;
		const bucket = who[rule.per];
		if (bucket === undefined) continue;
		out.push({ rule: `${rule.key}:${rule.rate}:${rule.per}`, bucket, ...parseRate(rule.rate) });
	}
	return out;
}
