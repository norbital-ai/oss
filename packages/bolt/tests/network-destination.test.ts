import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	publicAddresses,
	publicDestination,
	connectPublic,
	pinnedLookup
} from '../src/engine/net.ts';

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
					expect(yield* Effect.flip(connectPublic(address, 1433))).toMatchObject({
						kind: 'invalid'
					});
				}
				expect(
					yield* Effect.flip(
						publicDestination('mixed.example', 993, async () => [
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
			const destination = yield* publicDestination('mail.example', 993, async () => [
				{ address: '8.8.8.8', family: 4 },
				{ address: '2606:4700:4700::1111', family: 6 }
			]);
			const result = yield* Effect.callback<string | import('node:dns').LookupAddress[], Error>(
				(resume) => {
					pinnedLookup(destination.addresses)(
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

it.effect(
	'keeps the original TLS hostname and checked numeric endpoint while allowing non-HTTP ports',
	() =>
		Effect.gen(function* () {
			let queries = 0;
			const resolve = async () => {
				queries++;
				return [{ address: queries === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
			};
			expect(yield* publicDestination('mail.example', 993, resolve)).toMatchObject({
				hostname: 'mail.example',
				port: 993,
				address: { address: '8.8.8.8', family: 4 }
			});
			expect(yield* Effect.flip(publicDestination('mail.example', 993, resolve))).toMatchObject({
				kind: 'invalid'
			});
			expect(queries).toBe(2);
			for (const port of [0, -1, 65536, 1.5, Number.NaN])
				expect(yield* Effect.flip(publicDestination('8.8.8.8', port))).toMatchObject({
					kind: 'invalid'
				});
			expect(
				yield* Effect.flip(publicAddresses(new URL('https://mail.example:993/'), resolve))
			).toMatchObject({ kind: 'invalid' });
			expect(
				yield* Effect.flip(publicAddresses(new URL('http://mail.example/'), resolve))
			).toMatchObject({ kind: 'invalid' });
		})
);
