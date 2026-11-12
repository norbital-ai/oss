import { expect } from '@effect/vitest';
import { Effect } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { AgentDrains } from '../src/engine/agent/index.ts';
import type { Json } from '../src/decl/values.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { envoys, type EnvoysConfig } from '../src/engine/envoys/index.ts';
import { Conversations, Live } from '../src/engine/services.ts';
import { manifest } from './catalogue-fixture.ts';
import { layer } from '../../bolt-cli/src/test/effect.ts';

const configuration = Effect.gen(function* () {
	const t = yield* TestWorkspace;
	return {
		engine: { manifest: t.manifest, db: t.db, live: yield* Live },
		conversations: yield* Conversations,
		agents: yield* AgentDrains,
		deliver: Effect.void,
		announce: () => Effect.void
	} satisfies EnvoysConfig;
});

layer(TestWorkspace.layer({ manifest }))('envoy native boundaries', (it) => {
	it.effect('refuses malformed native admission before touching the database', () =>
		Effect.scoped(Effect.gen(function* () {
			const cfg = yield* configuration;
			let reads = 0;
			const db: TenantDbShape = {
				...cfg.engine.db,
				read: (statements) => Effect.suspend(() => {
					reads++;
					return cfg.engine.db.read(statements);
				})
			};
			const api = yield* envoys({ ...cfg, engine: { ...cfg.engine, db } });
			const invalid: readonly Json[] = [
				null,
				{},
				{ message: 23 },
				{ message: 'm', mentions: ['sender', 23] },
				{ message: 'm', extra: true }
			];
			for (const input of invalid)
				expect(yield* Effect.result(api.admit(input))).toMatchObject({
					_tag: 'Failure', failure: { _tag: 'BoltError', code: 'invalid_input' }
				});
			expect(reads).toBe(0);
		}))
	);

	it.effect('treats only an absent message as ignored and preserves missing or malformed query evidence', () =>
		Effect.scoped(Effect.gen(function* () {
			const cfg = yield* configuration;
			const absent = yield* envoys({
				...cfg,
				engine: { ...cfg.engine, db: { ...cfg.engine.db, read: () => Effect.succeed([{ rows: [], affected: 0 }]) } }
			});
			expect(yield* absent.admit({ message: 'missing' })).toEqual({ admission: 'ignored' });
			const missing = yield* envoys({
				...cfg,
				engine: { ...cfg.engine, db: { ...cfg.engine.db, read: () => Effect.succeed([]) } }
			});
			expect(yield* Effect.result(missing.admit({ message: 'm' }))).toMatchObject({
				_tag: 'Failure', failure: { _tag: 'BoltError', code: 'corrupt' }
			});
			const malformed = yield* envoys({
				...cfg,
				engine: { ...cfg.engine, db: { ...cfg.engine.db, read: () => Effect.succeed([{
					rows: [{
						integration: 'desk', conversation: 'channel', sender: 'sender', sender_name: 23,
						text: 'Hello', invocation: 'mention', subject: null, authenticated: null,
						fresh: true, thread: 'channel', kind: 'dm', status: 'idle',
						definition: 'whatsapp', envoy: '0199a000-0000-7000-8000-0000000000e1', serving: true
					}],
					affected: 0
				}]) } }
			});
			expect(yield* Effect.result(malformed.admit({ message: 'm' }))).toMatchObject({
				_tag: 'Failure', failure: { _tag: 'BoltError', code: 'corrupt' }
			});
		}))
	);

	it.effect('shipping distinguishes an absent channel from a missing result or malformed last-message envelope', () =>
		Effect.scoped(Effect.gen(function* () {
			const configured = yield* configuration;
			const cfg = {
				...configured,
				agents: { drain: () => Effect.succeed({ ran: false, reply: null }) }
			} satisfies EnvoysConfig;
			const absent = yield* envoys({
				...cfg,
				engine: { ...cfg.engine, db: { ...cfg.engine.db, read: () => Effect.succeed([{ rows: [], affected: 0 }]) } }
			});
			expect(yield* absent.drain('missing')).toEqual({ ran: false, sent: 0 });
			const missing = yield* envoys({
				...cfg,
				engine: { ...cfg.engine, db: { ...cfg.engine.db, read: () => Effect.succeed([]) } }
			});
			expect(yield* Effect.result(missing.drain('channel'))).toMatchObject({
				_tag: 'Failure', failure: { _tag: 'BoltError', code: 'corrupt' }
			});
			const malformed = yield* envoys({
				...cfg,
				engine: { ...cfg.engine, db: { ...cfg.engine.db, read: () => Effect.succeed([{
					rows: [{ integration: 'desk', thread: 'channel', definition: 'whatsapp', last: 'a message' }],
					affected: 0
				}]) } }
			});
			expect(yield* Effect.result(malformed.drain('channel'))).toMatchObject({
				_tag: 'Failure', failure: { _tag: 'BoltError', code: 'corrupt' }
			});
		}))
	);
});
