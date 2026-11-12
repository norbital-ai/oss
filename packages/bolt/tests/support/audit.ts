import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Layer } from 'effect';
import { memory_audit } from '../../../bolt-cli/src/test/audit.ts';
import { audit_from_abi } from '../../src/engine/audit.ts';

/** A durable in-process audit facility for a bare engine context; `TestWorkspace.layer` builds its own. */
export const memory_audit_layer: Layer.Layer<never> = Layer.unwrap(
	Effect.map(Effect.sync(memory_audit), (store) =>
		audit_from_abi(store.port).pipe(Layer.provide(NodeCrypto.layer))
	)
);
