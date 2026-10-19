import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { imap } from '../src/imap-smtp/mailbox-watch.ts';
import { mailCall, type Mailbox } from '../src/imap-smtp/model.ts';
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

it.effect(
	'the production IMAP adapter refuses private and metadata destinations before opening a client',
	() =>
		Effect.gen(function* () {
			for (const host of ['127.0.0.1', '169.254.169.254', '::1']) {
				const failure = yield* Effect.scoped(imap(box(host), login, false)).pipe(Effect.flip);
				expect(failure._tag).toBe('ProviderUnavailable');
				expect(failure.message).toContain('private or reserved');
			}
		})
);

it.live(
	'the production SMTP socket callback refuses private destinations on each verify connection',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const transport = yield* smtp(box('127.0.0.1'), login, false);
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
