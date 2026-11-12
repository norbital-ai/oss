// The facilities' Promise ABI adapters as engine services: every host (HOST_API, the test engine) composes the same.
import { Crypto, Effect, Layer, PlatformError } from 'effect';
import { sha256 } from '@norbital-ai/store';
import { audit_from_abi } from '../engine/audit.ts';
import { sha1 } from '../engine/crypto.ts';
import { Ai, Files, Http, Keys, Logs, Transport } from '../engine/ports.ts';
import type { Facilities } from '../facilities/index.ts';
import { is_off, off } from '../facilities/off.ts';
import { Turnstile } from '../shell/host.ts';

/** Random bytes from the runtime's `crypto`; the digests are this release's own (a cell has no `crypto.subtle`). */
export const cryptoLayer = Layer.succeed(
	Crypto.Crypto,
	Crypto.make({
		randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
		digest: (algorithm, data) =>
			algorithm === 'SHA-1'
				? Effect.succeed(sha1(data))
				: algorithm === 'SHA-256'
					? Effect.succeed(sha256(data))
					: Effect.fail(
							PlatformError.badArgument({
								module: 'Crypto',
								method: 'digest',
								description: `${algorithm} is not supported`
							})
						)
	})
);
/** The facilities' engine services, each member across its Promise ABI adapter. */
export const facility_layers = (f: Facilities) =>
	Layer.mergeAll(
		audit_from_abi(f.logs.audit).pipe(Layer.provide(cryptoLayer)),
		Logs.fromAbi(f.logs.runtime),
		Files.fromAbi(f.storage.files),
		Ai.fromAbi(f.intelligence),
		Keys.fromAbi(f.keys),
		Http.fromAbi(is_off(f.ports.outbound) ? off : f.ports.outbound.http),
		Turnstile.fromAbi(f.transactional.challenge),
		Transport.fromAbi({
			Mail: f.transactional.mail,
			Sms: f.transactional.sms,
			Push: is_off(f.transactional.push) ? off : f.transactional.push(f.storage.database)
		})
	);
