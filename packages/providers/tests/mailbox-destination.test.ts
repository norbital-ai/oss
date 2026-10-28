import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { tcpPort } from '@norbital-ai/bolt/node';
import { imap } from '../src/imap-smtp/mailbox-watch.ts';
import { mailCall, type Mailbox, type MailNet } from '../src/imap-smtp/model.ts';
import { smtp } from '../src/imap-smtp/submit.ts';

const box = (host: string): Mailbox => ({
	method: 'password',
	address: 'fixture@example.com',
	user: 'fixture',
	password: 'fixture',
	fromName: null,
	folder: 'INBOX',
	tracking: false,
	quietHours: 0,
	imap: { host, port: 993 },
	smtp: { host, port: 465 },
	pixelKey: 'fixture'
});
const login = { user: 'fixture', pass: 'fixture' };
/** The production network: the host's public TCP/TLS port. */
const net: MailNet = { tcp: tcpPort, plain: false };

it.live(
	'IMAP over the host port refuses private and metadata destinations',
	() =>
		Effect.gen(function* () {
			for (const host of ['127.0.0.1', '169.254.169.254', '::1']) {
				const failure = yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* imap(box(host), login, net);
						yield* mailCall('connect IMAP', () => client.connect());
					})
				).pipe(Effect.flip);
				expect(failure._tag).toBe('ProviderUnavailable');
				expect(failure.message).toContain('private or reserved');
			}
		})
);

it.live(
	'SMTP over the host port refuses private destinations on each verify connection',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const transport = yield* smtp(box('127.0.0.1'), login, net);
				for (let attempt = 0; attempt < 2; attempt++) {
					const failure = yield* mailCall('verify SMTP', () => transport.verify()).pipe(
						Effect.flip
					);
					expect(failure._tag).toBe('ProviderUnavailable');
					expect(failure.message).toContain('private or reserved');
				}
			})
		)
);
