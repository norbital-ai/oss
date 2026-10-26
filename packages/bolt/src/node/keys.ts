/// <reference types="node" />
// The tenant's secrets key held by the host (`KeysPort`, F21): AES-256-GCM envelopes `iv ‖ tag ‖ ciphertext` bound to
// `aad`; the key never reaches the engine.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Effect, Result } from 'effect';
import type { KeysPort } from '../engine/contracts.ts';

export function keysPort(key: Uint8Array): KeysPort {
	if (key.byteLength !== 32) throw new Error('the secrets key must be 32 bytes (AES-256)');
	const seal = (plain: Uint8Array, aad: Uint8Array) => {
		const iv = randomBytes(12),
			cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad);
		const content = Buffer.concat([cipher.update(plain), cipher.final()]);
		return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), content]));
	};
	// a copied envelope never opens under another owner or name: it is `null`, not a rejection
	const open = (sealed: Uint8Array, aad: Uint8Array) =>
		Result.getOrElse(
			Result.try(() => {
				const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12)).setAAD(aad);
				decipher.setAuthTag(sealed.subarray(12, 28));
				return new Uint8Array(
					Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
				);
			}),
			() => null
		);
	return {
		seal: (plain, aad) => Effect.runPromise(Effect.sync(() => seal(plain, aad))),
		open: (sealed, aad) => Effect.runPromise(Effect.sync(() => open(sealed, aad)))
	};
}
