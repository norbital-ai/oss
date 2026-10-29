import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Activation, Conversations, Outbound } from '../src/engine/services.ts';
import { OutboundLive } from '../src/engine/integrations/outbound.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';

it.live('keeps missing default epochs implicit and persists only changed epochs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest: base })),
				t = Context.get(context, TestWorkspace);
			const stored = () =>
				t.db.rows(Schema.Struct({ value: Schema.String, version: Schema.String }), {
					text: "SELECT value,xmin::text AS version FROM sys_config WHERE key='integrations.epoch'",
					params: []
				});
			const activate = (epoch: string) =>
				Effect.gen(function* () {
					const updated = yield* Layer.build(
						OutboundLive.pipe(
							Layer.provide(
								Layer.succeedContext(
									Context.add(context, Activation, { ...Context.get(context, Activation), epoch })
								)
							)
						)
					);
					yield* Context.get(updated, Outbound).activate;
				});
			expect(yield* stored()).toEqual([]);
			yield* activate('');
			expect(yield* stored()).toEqual([]);
			yield* activate('fork-1');
			const first = yield* stored();
			expect(first[0]?.value).toBe('fork-1');
			yield* activate('fork-1');
			expect(yield* stored()).toEqual(first);
			yield* activate('fork-2');
			const second = yield* stored();
			expect(second[0]?.value).toBe('fork-2');
			expect(second[0]?.version).not.toBe(first[0]?.version);
		})
	)
);
it.live('a conversation sends once and records its provider receipt', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest: { ...base, connections: { desk: { integration: 'whatsapp' } } }
				})
			);
			const t = Context.get(context, TestWorkspace),
				conversations = Context.get(context, Conversations),
				outbound = Context.get(context, Outbound);
			const id = yield* conversations.send(
				'desk',
				{
					to: '6591234567@s.whatsapp.net',
					text: 'Hello'
				},
				{}
			);
			yield* outbound.deliver;
			yield* outbound.deliver;
			expect(t.fakes.links.sent).toHaveLength(1);
			expect(
				yield* t.db.rows(
					Schema.Struct({ id: Schema.String, status: Schema.String, provider_id: Schema.String }),
					{
						text: "SELECT id,status,provider_id FROM sys_message WHERE direction='outbound'",
						params: []
					}
				)
			).toMatchObject([{ id, status: 'sent' }]);
		})
	)
);
