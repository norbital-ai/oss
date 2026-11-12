import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	public_addresses,
	public_destination,
	connect_public,
	pinned_lookup
} from '../src/node/net.ts';

it.effect(
	'rejects every private/reserved answer before TCP, including mixed DNS and mapped IPv6',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				for (const address of [
					'127.0.0.1',
					'10.1.2.3',
					'169.254.169.254',
					'100.64.0.1',
					'192.168.1.1',
					'::1',
					'fc00::1',
					'::ffff:127.0.0.1'
				]) {
					expect(yield* Effect.flip(connect_public(address, 1433))).toMatchObject({
						kind: 'invalid'
					});
				}
				expect(
					yield* Effect.flip(
						public_destination('mixed.example', 993, async () => [
							{ address: '8.8.8.8', family: 4 },
							{ address: '127.0.0.1', family: 4 }
						])
					)
				).toMatchObject({ kind: 'invalid' });
			})
		)
);

it.effect(
	'pins connector lookup to the checked DNS answers instead of resolving its hostname again',
	() =>
		Effect.gen(function* () {
			const destination = yield* public_destination('mail.example', 993, async () => [
				{ address: '8.8.8.8', family: 4 },
				{ address: '2606:4700:4700::1111', family: 6 }
			]);
			const result = yield* Effect.callback<string | import('node:dns').LookupAddress[], Error>(
				(resume) => {
					pinned_lookup(destination.addresses)(
						'rebound.example',
						{ all: true },
						(error, addresses) =>
							resume(error === null ? Effect.succeed(addresses) : Effect.fail(error))
					);
				}
			);
			expect(result).toEqual(destination.addresses);
		})
);

it.effect('normalizes bracketed IPv6 at TCP and HTTP admission without weakening the loopback guard', () =>
	Effect.gen(function* () {
		const address = '2606:4700:4700::1111';
		expect(yield* public_destination(`[${address}]`, 443)).toMatchObject({
			hostname: address,
			addresses: [{ address, family: 6 }]
		});
		expect(yield* public_addresses(new URL(`https://[${address}]/`))).toEqual([{ address, family: 6 }]);
		expect(yield* Effect.flip(public_addresses(new URL('https://[::1]/')))).toMatchObject({ kind: 'invalid' });
		expect(yield* public_addresses(new URL('http://[::1]:8000/'), undefined, true)).toEqual([{ address: '::1', family: 6 }]);
	})
);

it.effect(
	'keeps the original TLS hostname and checked numeric endpoint while allowing non-HTTP ports',
	() =>
		Effect.gen(function* () {
			let queries = 0;
			const resolve = async () => {
				queries++;
				return [{ address: queries === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
			};
			expect(yield* public_destination('mail.example', 993, resolve)).toMatchObject({
				hostname: 'mail.example',
				port: 993,
				address: { address: '8.8.8.8', family: 4 }
			});
			expect(yield* Effect.flip(public_destination('mail.example', 993, resolve))).toMatchObject({
				kind: 'invalid'
			});
			expect(queries).toBe(2);
			for (const port of [0, -1, 65536, 1.5, Number.NaN])
				expect(yield* Effect.flip(public_destination('8.8.8.8', port))).toMatchObject({
					kind: 'invalid'
				});
			expect(
				yield* Effect.flip(public_addresses(new URL('https://mail.example:993/'), resolve))
			).toMatchObject({ kind: 'invalid' });
			expect(
				yield* Effect.flip(public_addresses(new URL('http://mail.example/'), resolve))
			).toMatchObject({ kind: 'invalid' });
		})
);
