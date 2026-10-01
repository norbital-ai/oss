// The mailbox email channel against local fake IMAP and SMTP servers (never a real mailbox): reading DSNs and NDRs,
// submit codes and the DSN request, watching the folder, the open pixel, and the channel's own OAuth (authorize URL,
// state refusals, code exchange with PKCE and sealing, refresh on use, a revoked refresh flipping the channel to error).
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelLink, Json } from '@norbital-ai/bolt/engine';
import { mailbox } from '../src/imap-smtp/index.ts';
import { readMail } from '../src/imap-smtp/reports.ts';
import { fakeFetch, host, json, signal } from './kit.ts';
import { fakeImap, fakeSmtp } from './mail-servers.ts';

const HOOK = 'https://ws.example/hooks/bolt.email/desk';
const until = async (ok: () => boolean, ms = 8_000) => {
	const end = Date.now() + ms;
	while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};
const mail = (headers: string, body = 'hello') => `${headers}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`;
const dsn = (action: string, status: string, diagnostic: string, envid = 'm-1') => `From: Mail Delivery System <MAILER-DAEMON@mx.example>
To: desk@acme.example
Subject: Delivery Status Notification
Message-ID: <r-${status}@mx.example>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="B"

--B
Content-Type: text/plain

Your message could not be delivered.
--B
Content-Type: message/delivery-status

Reporting-MTA: dns; mx.example
Original-Envelope-Id: ${envid}

Final-Recipient: rfc822; carol@else.example
Action: ${action}
Status: ${status}
${diagnostic === '' ? '' : `Diagnostic-Code: smtp; ${diagnostic}\n`}
--B
Content-Type: text/rfc822-headers

Message-ID: <m-1@acme.example>
Subject: hello

--B--
`;

describe('reading the watched folder', () => {
	it('an RFC 3464 DSN is a report on the message its envelope id names: bounced, deferred, delivered', async () => {
		expect(await readMail(dsn('failed', '5.1.1', '550 5.1.1 <carol@else.example>: Recipient address rejected'), 'acme.example', 'x')).toEqual({ kind: 'report',
			ids: ['<m-1@acme.example>'], report: { kind: 'bounced', permanent: true, code: '550 5.1.1', reason: '550 5.1.1 <carol@else.example>: Recipient address rejected' } });
		expect((await readMail(dsn('delayed', '4.4.7', ''), 'acme.example', 'x'))).toMatchObject({ report: { kind: 'deferred', permanent: false, code: '4.4.7' } });
		expect((await readMail(dsn('delivered', '2.0.0', '250 2.0.0 OK'), 'acme.example', 'x'))).toMatchObject({ report: { kind: 'delivered', code: '250 2.0.0' } });
		expect((await readMail(dsn('relayed', '2.0.0', ''), 'acme.example', 'x'))).toMatchObject({ report: { kind: 'delivered', presumed: true } });
		// a report about someone else's message names none of ours
		expect(await readMail(dsn('failed', '5.1.1', '', '<other@elsewhere.example>'), 'elsewhere.example', 'x')).toMatchObject({ ids: ['<other@elsewhere.example>'] });
	});
	it('a legacy NDR in prose (qmail) is a bounce on the quoted Message-ID; Exchange\'s In-Reply-To also names it', async () => {
		const qmail = mail('From: MAILER-DAEMON@mx.example\nTo: desk@acme.example\nSubject: failure notice\nMessage-ID: <q1@mx.example>',
			'Hi. This is the qmail-send program at mx.example.\nI\'m afraid I wasn\'t able to deliver your message to the following addresses.\n\n<carol@else.example>:\n'
			+ 'Remote host said: 550 5.7.1 Relaying denied\n\n--- Below this line is a copy of the message.\n\nMessage-ID: <m-9@acme.example>\nSubject: hi\n');
		expect(await readMail(qmail, 'acme.example', 'x')).toEqual({ kind: 'report', ids: ['<m-9@acme.example>'],
			report: { kind: 'bounced', permanent: true, code: '550 5.7.1', reason: 'Remote host said: 550 5.7.1 Relaying denied' } });
		const delayed = mail('From: postmaster@outlook.example\nTo: desk@acme.example\nSubject: Delivery delayed: hello\nIn-Reply-To: <m-2@acme.example>',
			'Delivery has been delayed. The server will keep trying. 451 4.4.0 DNS query failed');
		expect(await readMail(delayed, 'acme.example', 'x')).toMatchObject({ ids: ['<m-2@acme.example>'], report: { kind: 'deferred', permanent: false, code: '451 4.4.0' } });
	});
	it('anything else is inbound mail with its headers (an auto-reply included: bolt tells it from a person)', async () => {
		const r = await readMail(mail('From: Carol <Carol@else.example>\nTo: desk@acme.example\nSubject: Automatic reply: hello\nAuto-Submitted: auto-replied\n'
			+ 'Message-ID: <c1@else.example>\nIn-Reply-To: <m-1@acme.example>\nDate: Wed, 30 Sep 2026 10:00:00 +0000', 'I am away'), 'acme.example', 'x');
		expect(r).toMatchObject({ kind: 'mail', from: 'carol@else.example', message: { id: '<c1@else.example>', subject: 'Automatic reply: hello', text: 'I am away\n',
			from: { address: 'carol@else.example', name: 'Carol' }, sentAt: '2026-09-30T10:00:00.000Z',
			headers: { 'auto-submitted': 'auto-replied', 'in-reply-to': '<m-1@acme.example>' } } });
	});
});

describe('the mailbox link (password)', () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
	async function setup(tracking = 'off') {
		const imap = await fakeImap({ accept: (u, s) => u === 'desk@acme.example' && s.pass === 'pw' });
		const smtp = await fakeSmtp({ accept: (_u, p) => p === 'pw' });
		imap.deliver(mail('From: old@else.example\nSubject: before\nMessage-ID: <old@else.example>')); // history: never replayed
		const provider = mailbox({ plain: true }).find((p) => p.id === 'imap')!;
		const h = await host(provider, fakeFetch([]), null, HOOK);
		cleanup.push(async () => { await h.link.close(); await imap.close(); await smtp.close(); });
		const input = { address: 'Desk@Acme.example', password: 'pw', imapHost: '127.0.0.1', imapPort: String(imap.port), smtpHost: '127.0.0.1',
			smtpPort: String(smtp.port), fromName: 'Acme Desk', tracking };
		return { imap, smtp, h, input };
	}

	it('a wrong password keeps nothing; a right one connects and watches from the next message', async () => {
		const { h, input, imap } = await setup();
		await expect(h.link.pair({ ...input, password: 'nope' })).rejects.toThrow(/IMAP 127.0.0.1/);
		expect(h.saved).toEqual([]);
		await expect(h.link.pair({ ...input, imapPort: 'x' })).rejects.toThrow(/IMAP port is not a port number/);
		await h.link.pair(input);
		await until(() => h.link.connection().state === 'connected');
		expect(h.link.connection()).toMatchObject({ pairedAs: 'desk@acme.example', stored: true, about: { address: 'desk@acme.example', folder: 'INBOX', openTracking: 'off' } });
		expect(h.saved.at(-1)).toMatchObject({ method: 'password', address: 'desk@acme.example', password: 'pw', cursor: { validity: '7', uid: 1 } });
		imap.deliver(mail('From: Carol <carol@else.example>\nTo: desk@acme.example\nSubject: Re: quote\nMessage-ID: <c2@else.example>\nIn-Reply-To: <m-1@acme.example>', 'yes'));
		imap.deliver(dsn('failed', '5.1.1', '550 5.1.1 unknown user'));
		imap.deliver(mail('From: desk@acme.example\nSubject: our own copy\nMessage-ID: <self@acme.example>'));
		await until(() => h.events.length >= 2);
		await new Promise((r) => setTimeout(r, 200));
		expect(h.events).toHaveLength(2);
		expect(h.events[0]).toMatchObject({ kind: 'inbound', channel: 'desk', message: { id: '<c2@else.example>', text: 'yes\n', headers: { 'in-reply-to': '<m-1@acme.example>' } } });
		expect(h.events[1]).toMatchObject({ kind: 'delivery', channel: 'desk', providerId: '<m-1@acme.example>', report: { kind: 'bounced', code: '550 5.1.1', provider: 'imap', permanent: true } });
		await until(() => (h.saved.at(-1) as { cursor?: { uid: number } }).cursor?.uid === 4);
	});

	it('backfills personal mailbox history in bounded batches with saved progress', async () => {
		const { imap, h, input } = await setup();
		await h.link.close();
		for (let i = 0; i < 60; i++) imap.deliver(mail(`From: customer@else.example\nMessage-ID: <history-${i}@else.example>`));
		const provider = mailbox({ plain: true }).find((p) => p.id === 'imap')!;
		const saved: (Json | null)[] = [], events: unknown[] = [];
		const link = await provider.open({ channel: 'personal', syncOnly: true, credential: null, webhookUrl: HOOK, fetch: fakeFetch([]),
			save: async (value) => { saved.push(value); }, emit: async (value) => { events.push(value); }, changed: () => {} });
		cleanup.push(() => link.close());
		await link.pair(input);
		await until(() => events.length === 61);
		await until(() => (saved.at(-1) as { cursor?: { uid: number } }).cursor?.uid === 61);
		expect(imap.fetches).toEqual([25, 25, 11]);
		expect(saved.some((value) => (value as { cursor?: { uid: number } } | null)?.cursor?.uid === 25)).toBe(true);
	});

	it('sends as the mailbox with a DSN request; 4xx is a retryable refusal, 5xx a permanent one, both with their codes', async () => {
		const { h, input, smtp } = await setup();
		await h.link.pair(input);
		const sent = await h.link.send('desk', { id: 'm-5', to: ['carol@else.example'], subject: 'Quote', text: 'Attached', html: '<p>Attached</p>',
			inReplyTo: '<c2@else.example>', references: ['<c2@else.example>'] } as unknown as Json, signal());
		expect(sent).toEqual({ providerId: '<m-5@acme.example>', presumeAfterMs: 24 * 3_600_000 });
		const got = smtp.sent.at(-1)!;
		expect(got.mailFrom).toMatch(/^MAIL FROM:<desk@acme\.example>.*RET=HDRS ENVID=m-5/);
		expect(got.rcpts[0]).toMatch(/RCPT TO:<carol@else\.example> NOTIFY=SUCCESS,FAILURE,DELAY/);
		expect(got.data).toMatch(/Message-ID: <m-5@acme\.example>/i);
		expect(got.data).toMatch(/In-Reply-To: <c2@else\.example>/i);
		expect(got.data).toMatch(/From: Acme Desk <desk@acme\.example>/);
		expect(got.data).not.toContain('/open/');
		const refusal = async (to: string) => h.link.send('desk', { id: 'm-6', to: [to], subject: 's', text: 't' } as unknown as Json, signal()).catch((e: unknown) => e);
		expect(await refusal('full@else.example')).toMatchObject({ name: 'SendRefused', permanent: false, code: '452 4.2.2' });
		expect(await refusal('nobody@else.example')).toMatchObject({ name: 'SendRefused', permanent: true, code: '550 5.1.1' });
	});

	it('attaches what bolt read for the message: each file its own MIME part with its name and content type', async () => {
		const { h, input, smtp } = await setup();
		await h.link.pair(input);
		const file = (id: string, name: string, text: string) => ({ id, name, mime: 'application/pdf', bytes: new TextEncoder().encode(text), url: async () => 'unused' });
		await h.link.send('desk', { id: 'm-8', to: ['carol@else.example'], subject: 'Notice', html: '<p>The attached report</p>',
			attachments: [{ id: 'f1' }, { id: 'f2' }] } as unknown as Json, signal(), [file('f1', 'PCN report.pdf', '%PDF report'), file('f2', 'datasheet.pdf', '%PDF sheet')]);
		const data = smtp.sent.at(-1)!.data;
		expect(data).toMatch(/Content-Type: multipart\/mixed/i);
		for (const [name, text] of [['PCN report.pdf', '%PDF report'], ['datasheet.pdf', '%PDF sheet']] as const) {
			expect(data).toMatch(new RegExp(`Content-Type: application/pdf; name="?${name}"?`, 'i'));
			expect(data).toMatch(new RegExp(`Content-Disposition: attachment; filename="?${name}"?`, 'i'));
			expect(data).toContain(Buffer.from(text).toString('base64'));
		}
	});

	it('open tracking: a pixel in HTML mail; its hit is an approximate open; a forged one is answered the same and reported nowhere', async () => {
		const { h, input, smtp } = await setup('on');
		await h.link.pair(input);
		await h.link.send('desk', { id: 'm-7', to: ['carol@else.example'], subject: 's', html: '<p>hi</p>' } as unknown as Json, signal());
		const pixel = /src=3D"([^"]+)"|src="([^"]+)"/.exec(smtp.sent.at(-1)!.data.replace(/=\r\n/g, ''));
		const url = (pixel?.[1] ?? pixel?.[2])!.replace(/=3D/g, '=');
		expect(url).toMatch(new RegExp(`^${HOOK}/open/m-7\\.[\\w-]{22}\\.gif$`));
		const forged = await h.link.webhook!(new Request(url.replace(/\.[\w-]{22}\.gif$/, '.AAAAAAAAAAAAAAAAAAAAAA.gif')));
		expect(forged.headers.get('content-type')).toBe('image/gif');
		expect(h.events).toEqual([]);
		const hit = await h.link.webhook!(new Request(url));
		expect(hit.status).toBe(200);
		expect(h.events).toMatchObject([{ kind: 'delivery', providerId: '<m-7@acme.example>', report: { kind: 'opened', approximate: true, provider: 'imap' } }]);
	});

	it('the test sends to the mailbox itself and finds it in the folder; the copy is not inbound', async () => {
		const { h, input, smtp, imap } = await setup();
		await h.link.pair(input);
		await until(() => h.link.connection().state === 'connected');
		const loop = setInterval(() => { const m = smtp.sent.shift(); if (m !== undefined) imap.deliver(m.data); }, 20); // the server delivers it back
		try { await h.link.test!(AbortSignal.timeout(10_000)); } finally { clearInterval(loop); }
		await new Promise((r) => setTimeout(r, 200));
		expect(h.events).toEqual([]);
	});
});

describe('the mailbox link (the channel\'s own OAuth)', () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
	async function setup(tokenRoute: (body: URLSearchParams) => Response) {
		let now = 1_800_000_000_000;
		const imap = await fakeImap({ accept: (u, s) => u === 'desk@acme.example' && (s.token === 'at-1' || s.token === 'at-2') });
		const smtp = await fakeSmtp({ accept: (_u, token) => token === 'at-1' || token === 'at-2' });
		const f = fakeFetch([(c) => c.url.endsWith('/oauth2/v2.0/token') ? tokenRoute(new URLSearchParams(c.body)) : undefined]);
		const servers = { imap: { host: '127.0.0.1', port: imap.port }, smtp: { host: '127.0.0.1', port: smtp.port } };
		const provider = mailbox({ plain: true, servers: { microsoft: servers }, now: () => now }).find((p) => p.id === 'microsoft')!;
		const h = await host(provider, f, null, HOOK);
		cleanup.push(async () => { await h.link.close(); await imap.close(); await smtp.close(); });
		return { h, f, imap, advance: (ms: number) => { now += ms; } };
	}
	const input = { address: 'desk@acme.example', tenant: 'contoso-id', clientId: 'app-1', clientSecret: 'shh' };
	const callback = (link: ChannelLink, q: string) => link.webhook!(new Request(`${HOOK}/oauth/callback?${q}`));
	const authorize = (link: ChannelLink) => new URL(link.connection().pairing!.value!);

	it('publishes an authorize URL for the popup: the tenant\'s app, PKCE, this channel\'s redirect URI, the mailbox scopes', async () => {
		const { h } = await setup(() => json({}));
		await h.link.pair(input);
		expect(h.link.connection()).toMatchObject({ state: 'pairing', pairing: { kind: 'oauth', label: 'Sign in with Microsoft' } });
		const url = authorize(h.link);
		expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/contoso-id/oauth2/v2.0/authorize');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'app-1', redirect_uri: `${HOOK}/oauth/callback`,
			code_challenge_method: 'S256', login_hint: 'desk@acme.example',
			scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access' });
		expect(url.searchParams.get('state')).toMatch(/^[\w-]{32}$/);
		expect(h.saved).toEqual([]); // nothing is kept before the sign-in
	});

	it('refuses a callback with a wrong or expired state; a good one exchanges the code with the verifier and seals the tokens', async () => {
		let exchanged: URLSearchParams | null = null;
		const { h, advance } = await setup((b) => { exchanged = b; return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }); });
		await h.link.pair(input);
		const state = authorize(h.link).searchParams.get('state')!;
		expect((await callback(h.link, 'state=forged&code=c1')).status).toBe(400);
		expect(exchanged).toBeNull();
		const res = await callback(h.link, `state=${state}&code=c1`);
		expect(await res.text()).toContain('Connected as desk@acme.example');
		expect(Object.fromEntries(exchanged!)).toMatchObject({ grant_type: 'authorization_code', code: 'c1', redirect_uri: `${HOOK}/oauth/callback`,
			client_id: 'app-1', client_secret: 'shh', code_verifier: expect.stringMatching(/^[\w-]{43}$/) });
		expect(h.saved.at(-1)).toMatchObject({ method: 'microsoft', oauth: { clientId: 'app-1', clientSecret: 'shh', tenant: 'contoso-id',
			tokens: { access: 'at-1', refresh: 'rt-1' } } });
		await until(() => h.link.connection().state === 'connected');
		// used once: the same state again is refused
		expect((await callback(h.link, `state=${state}&code=c1`)).status).toBe(400);
		// an attempt left for longer than ten minutes is refused
		await h.link.pair(input);
		const late = authorize(h.link).searchParams.get('state')!;
		advance(11 * 60_000);
		expect((await callback(h.link, `state=${late}&code=c2`)).status).toBe(400);
	});

	it('refreshes an expired token on use and seals the rotation; a revoked refresh flips the channel to error', async () => {
		let mode: 'first' | 'refresh' | 'revoked' = 'first';
		const grants: string[] = [];
		const { h, advance } = await setup((b) => {
			grants.push(b.get('grant_type')!);
			if (mode === 'revoked') return json({ error: 'invalid_grant', error_description: 'AADSTS50173: the grant was revoked' }, 400);
			return mode === 'first' ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) : json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
		});
		await h.link.pair(input);
		await callback(h.link, `state=${authorize(h.link).searchParams.get('state')}&code=c1`);
		mode = 'refresh';
		advance(2 * 3_600_000);
		await h.link.send('desk', { id: 'm-1', to: ['carol@else.example'], subject: 's', text: 't' } as unknown as Json, signal());
		expect(grants).toEqual(['authorization_code', 'refresh_token']);
		expect(h.saved.at(-1)).toMatchObject({ oauth: { tokens: { access: 'at-2', refresh: 'rt-2' } } });
		mode = 'revoked';
		advance(2 * 3_600_000);
		const e = await h.link.send('desk', { id: 'm-2', to: ['carol@else.example'], subject: 's', text: 't' } as unknown as Json, signal()).catch((x: unknown) => x);
		expect(e).toMatchObject({ name: 'SendRefused' });
		expect(h.link.connection()).toMatchObject({ state: 'error', stored: true, error: expect.stringMatching(/revoked or has expired.*sign in again/) });
	});
});
