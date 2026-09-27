// The runs area without a database: cron (rule 52), buckets (rule 52a), the in-process deadlines port, webhook
// signatures per scheme (rule 56a), and what retries (rule 54).
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoltError } from '../src/engine/contracts.ts';
import { nextSlot, parseCron, periodAtLeast5Min } from '../src/engine/runs/cron.ts';
import { transient } from '../src/engine/runs/index.ts';
import { dueAt } from '../src/engine/runs/queue.ts';
import { inProcessDeadlines } from '../src/engine/runs/scheduler.ts';
import { verifySignature, type WebhookRequest } from '../src/engine/runs/webhook.ts';

const at = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();

describe('cron (rule 52)', () => {
	it('parses 5 fields or a macro and refuses anything else', () => {
		expect(parseCron('@daily')).toEqual(parseCron('0 0 * * *'));
		expect(parseCron('*/15 9-17 * jan-mar mon-fri').minutes).toEqual([0, 15, 30, 45]);
		for (const bad of ['* * * *', '60 * * * *', '*/0 * * * *', '5-1 * * * *']) expect(() => parseCron(bad)).toThrow(BoltError);
	});

	it('computes slots in its zone: a nonexistent time fires at the next valid instant, a repeated one once', () => {
		const ny = 'America/New_York';
		// 2026-03-08: 02:30 does not exist in New York; the slot fires at 03:00 EDT
		expect(iso(nextSlot(parseCron('30 2 * * *'), at('2026-03-08T05:00:00Z'), ny))).toBe('2026-03-08T07:00:00.000Z');
		// 2026-11-01: 01:30 happens twice; the slot fires at the first (EDT) and not again
		const first = nextSlot(parseCron('30 1 * * *'), at('2026-11-01T04:00:00Z'), ny);
		expect(iso(first)).toBe('2026-11-01T05:30:00.000Z');
		expect(iso(nextSlot(parseCron('30 1 * * *'), first, ny))).toBe('2026-11-02T06:30:00.000Z');
		expect(iso(nextSlot(parseCron('0 6 * * *'), at('2026-09-25T10:00:00Z'), 'Asia/Singapore'))).toBe('2026-09-25T22:00:00.000Z');
	});

	it('knows when its period is 5 minutes or more', () => {
		expect(periodAtLeast5Min(parseCron('*/15 * * * *'))).toBe(true);
		expect(periodAtLeast5Min(parseCron('0 6 * * *'))).toBe(true);
		expect(periodAtLeast5Min(parseCron('* * * * *'))).toBe(false);
		expect(periodAtLeast5Min(parseCron('0,58 * * * *'))).toBe(false);
	});
});

describe('buckets (rule 52a)', () => {
	it('a due time under 5 minutes ahead is exact; 5 minutes or more rounds up to the bucket', () => {
		const now = at('2026-09-25T09:01:17Z');
		expect(iso(dueAt(now, now + 60_000))).toBe('2026-09-25T09:02:17.000Z');
		expect(iso(dueAt(now, now + 3 * 86_400_000))).toBe('2026-09-28T09:05:00.000Z');
		expect(iso(dueAt(now, at('2026-09-25T09:10:00Z')))).toBe('2026-09-25T09:10:00.000Z');
	});
});

describe('the in-process deadlines port', () => {
	afterEach(() => { vi.useRealTimers(); });

	it('wakes a scope once at its earliest instant and re-arms from the tick\'s settle; idle arms no timer', async () => {
		vi.useFakeTimers({ now: at('2026-09-25T00:00:00Z') });
		const wakes: string[] = [];
		const port = inProcessDeadlines(async (scope) => {
			wakes.push(`${scope}@${new Date().toISOString()}`);
			if (wakes.length === 1) port.settle(scope, '2026-09-25T02:00:00.000Z');
			else port.settle(scope, null);
		});
		port.announce('ws', '2026-09-25T01:00:00.000Z');
		port.announce('ws', '2026-09-25T01:30:00.000Z');   // later: no change
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(7 * 86_400_000);
		expect(wakes).toEqual(['ws@2026-09-25T01:00:00.000Z', 'ws@2026-09-25T02:00:00.000Z']);
		expect(vi.getTimerCount()).toBe(0);
		port.stop();
	});

	it('an announcement made while the scope wakes is merged with the tick\'s answer', async () => {
		vi.useFakeTimers({ now: at('2026-09-25T00:00:00Z') });
		const wakes: string[] = [];
		const port = inProcessDeadlines(async (scope) => {
			wakes.push(new Date().toISOString());
			if (wakes.length === 1) port.announce(scope, '2026-09-25T00:10:00.000Z');
			port.settle(scope, wakes.length === 1 ? '2026-09-25T05:00:00.000Z' : null);
		});
		port.announce('ws', '2026-09-25T00:01:00.000Z');
		await vi.advanceTimersByTimeAsync(86_400_000);
		expect(wakes).toEqual(['2026-09-25T00:01:00.000Z', '2026-09-25T00:10:00.000Z']);
		port.stop();
	});
});

describe('webhook signatures (rule 56a)', () => {
	const now = at('2026-09-25T10:00:00Z'), ts = String(now / 1000), secret = 'shh';
	const body = Buffer.from('{"id":"evt_1"}');
	const hm = (key: string | Buffer, text: string, enc: 'hex' | 'base64') => createHmac('sha256', key).update(text).digest(enc);
	const req = (headers: WebhookRequest['headers']): WebhookRequest => ({ method: 'POST', headers, body });
	const svixKey = Buffer.from('svix-secret-bytes');
	const cases: [string, string, WebhookRequest][] = [
		['bearer', secret, req({ authorization: 'Bearer shh' })],
		['hmac-sha256', secret, req({ 'x-signature': `sha256=${hm(secret, body.toString(), 'hex')}` })],
		['meta', secret, req({ 'x-hub-signature-256': `sha256=${hm(secret, body.toString(), 'hex')}` })],
		['slack', secret, req({ 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hm(secret, `v0:${ts}:${body}`, 'hex')}` })],
		['stripe', secret, req({ 'stripe-signature': `t=${ts},v1=${hm(secret, `${ts}.${body}`, 'hex')}` })],
		['svix', `whsec_${svixKey.toString('base64')}`, req({ 'svix-id': 'msg_1', 'svix-timestamp': ts,
			'svix-signature': `v1,${hm(svixKey, `msg_1.${ts}.${body}`, 'base64')}` })],
	];
	it.each(cases)('%s: a valid signature passes; a wrong secret, a changed body or a stale timestamp fails', (scheme, key, r) => {
		expect(verifySignature(scheme, key, r, now)).toBe(true);
		expect(verifySignature(scheme, scheme === 'svix' ? 'whsec_b3RoZXI=' : `${key}x`, r, now)).toBe(false);
		expect(verifySignature(scheme, key, { ...r, body: Buffer.from('{"id":"evt_2"}') }, now)).toBe(scheme === 'bearer');
		if (['slack', 'stripe', 'svix'].includes(scheme)) expect(verifySignature(scheme, key, r, now + 600_000)).toBe(false);
	});
});

describe('attempts (rule 54)', () => {
	const failed = (code: string, message = '') => ({ kind: 'failed' as const, error: new BoltError(code, 'guest', message), cpuMs: 0 });
	it('only Transient retries: facility upstream, timeout, rateLimited and an act conflict, thrown or coded', () => {
		expect(transient(failed('guestError', JSON.stringify({ kind: 'upstream', message: '502' })))).toBe(true);
		expect(transient(failed('guestError', JSON.stringify({ kind: 'conflict', records: [] })))).toBe(true);
		expect(transient(failed('timeout'))).toBe(true);
		expect(transient(failed('guestError', 'TypeError: x is undefined'))).toBe(false);
		expect(transient(failed('cpuBudget'))).toBe(false);
		expect(transient({ kind: 'refused', message: 'no', cpuMs: 0 })).toBe(false);
	});
});
