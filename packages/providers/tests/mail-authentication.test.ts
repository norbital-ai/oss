// A mail's `From` is free text, so a sender is believed only on its receiving server's verdict: every forgery below must
// fail, because the one that passes hands a stranger a member's authority.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { authenticated, readMail } from '../src/imap-smtp/reports.ts';

const FROM = 'dana@acme.example';
const GOOGLE =
	'mx.google.com; dkim=pass header.i=@acme.example header.s=s1 header.b=abc; spf=pass (google.com: domain of dana@acme.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=dana@acme.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.example';
const MICROSOFT =
	'spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=acme.example; dkim=pass (signature was verified) header.d=acme.example;dmarc=pass action=none header.from=acme.example;compauth=pass reason=100';
const headers = (...results: readonly string[]) => [
	...results.map((value) => ({ key: 'authentication-results', value })),
	{ key: 'from', value: FROM }
];
const believed = (results: readonly string[], receiver?: string | null, from = FROM) =>
	authenticated(headers(...results), from, receiver);

describe('a mail sender', () => {
	it('is believed on a known server’s verdict for its own domain', () => {
		expect(believed([GOOGLE], 'mx.google.com')).toBe(true);
		expect(believed([MICROSOFT], null)).toBe(true);
		expect(believed(['mx.acme.example 1; dmarc=pass header.from=acme.example'], 'mx.acme.example')).toBe(true);
	});
	it('is believed on an aligned DKIM signature, for a domain with no DMARC record', () => {
		expect(believed(['mx.test; dkim=pass header.d=acme.example; dmarc=none'], 'mx.test')).toBe(true);
		expect(believed(['mx.test; dkim=pass header.d=mail.acme.example'], 'mx.test')).toBe(true);
		expect(believed(['mx.test; dkim=pass header.i=@acme.example'], 'mx.test')).toBe(true);
	});
	it('is not believed where no server is known or none spoke', () => {
		expect(believed([GOOGLE])).toBe(false);
		expect(believed([], 'mx.google.com')).toBe(false);
		expect(believed([], null)).toBe(false);
	});
	it('is not believed on a header the sender wrote', () => {
		const forged = 'mx.google.com; dmarc=pass header.from=acme.example';
		expect(believed(['mx.google.com; dmarc=fail header.from=acme.example', forged], 'mx.google.com')).toBe(false);
		// the top header is the receiver's: a mailbox that wrote none cannot be spoken for by a stranger's
		expect(believed(['mx.evil.example; dmarc=pass header.from=acme.example'], 'mx.google.com')).toBe(false);
		expect(believed(['dmarc=pass header.from=acme.example'], 'mx.google.com')).toBe(false);
	});
	it('is not believed when the proof is someone else’s', () => {
		expect(believed(['mx.test; dkim=pass header.d=evil.example; dmarc=fail header.from=acme.example'], 'mx.test')).toBe(false);
		expect(believed(['mx.test; dmarc=pass header.from=evil.example'], 'mx.test')).toBe(false);
		expect(believed(['mx.test; dkim=pass header.d=acme.example.evil.example'], 'mx.test')).toBe(false);
		// a parent's signature does not prove a subdomain the parent may not run
		expect(believed(['mx.test; dkim=pass header.d=acme.example'], 'mx.test', 'dana@mail.acme.example')).toBe(false);
	});
	it('is not believed on SPF, which proves the envelope and never From', () => {
		expect(believed(['mx.test; spf=pass smtp.mailfrom=acme.example; dmarc=none'], 'mx.test')).toBe(false);
		expect(believed(['mx.test; dmarc=bestguesspass header.from=acme.example'], 'mx.test')).toBe(false);
	});
	it('is not believed on text the sender smuggled into a comment or a quoted value', () => {
		const smuggled = [
			'mx.test; spf=pass (domain of x;dmarc=pass header.from=acme.example;y) smtp.mailfrom=evil.example',
			'mx.test; spf=pass (nested (one) ; dmarc=pass header.from=acme.example ) smtp.mailfrom=evil.example',
			'mx.test; spf=pass smtp.mailfrom="x;dmarc=pass header.from=acme.example;"@evil.example',
			'mx.test; dmarc=fail header.from="evil.example header.from=acme.example"',
			'mx.test; dkim=pass note="a header.d=acme.example b" header.d=evil.example',
			String.raw`mx.test; spf=pass smtp.mailfrom="x\";dmarc=pass header.from=acme.example;"@evil.example`
		];
		for (const value of smuggled) expect(believed([value], 'mx.test')).toBe(false);
	});
	it('is not believed with two From headers, one for the verdict and one for us', () => {
		expect(
			authenticated([...headers(GOOGLE), { key: 'from', value: 'x@evil.example' }], FROM, 'mx.google.com')
		).toBe(false);
	});
	it.effect('reaches the engine only when proved, read from a raw message', () =>
		Effect.gen(function* () {
			const raw = (results: string) =>
				`Authentication-Results: ${results}\r\nFrom: Dana <${FROM}>\r\nTo: desk@ws.example\r\nSubject: Hi\r\nMessage-ID: <m1@acme.example>\r\n\r\nHello`;
			const read = (results: string, receiver?: string | null) =>
				readMail(raw(results), 'ws.example', 'x', true, undefined, undefined, receiver);
			expect(yield* read(GOOGLE, 'mx.google.com')).toMatchObject({ message: { authenticated: true } });
			expect(yield* read(GOOGLE)).not.toMatchObject({ message: { authenticated: true } });
		})
	);
});
