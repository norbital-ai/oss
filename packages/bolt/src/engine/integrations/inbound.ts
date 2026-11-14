// A definition's webhook handler (`webhook.handle`): one verified delivery to one instance, run in the guest as the
// reserved system identity holding the webhook's `policies`. It reads and acts as those policies and answers the
// provider's request with its own status and body. A refusal answers 422, any other failure 500 (the provider redelivers).
import { Clock, Effect, Predicate, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { cross_failure, LIMITS, type CrossAnswer } from '../contracts.ts';
import { bindingsAt } from '../query/reader.ts';
import { Callables, Guest, Identity, Manifest, Reads, type Bridge } from '../services.ts';

/** A verified delivery as the handler receives it; `text` is the raw body, `body` it decoded as JSON (else null). */
export type InboundRequest = {
	readonly method: string;
	readonly headers: { readonly [lowercase: string]: string };
	readonly query: { readonly [name: string]: string };
	readonly body: Json;
	readonly text: string;
};
const Reply = Schema.NullOr(
	Schema.Struct({
		status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 }))),
		body: Schema.optionalKey(Schema.Json)
	})
);

export const inbound = Effect.fn('Integrations.inbound')(function* (
	id: string,
	integration: string,
	instance: { readonly id: string; readonly configuration: Json },
	policies: readonly string[],
	request: InboundRequest
) {
	const m = yield* Manifest,
		guest = yield* Guest,
		reads = yield* Reads,
		calls = yield* Callables,
		identity = yield* Identity;
	const b = bindingsAt(yield* Clock.currentTimeMillis, m.workspace.tz);
	// the instance stands as its run: history names the connection, and a redelivery's keyed act answers from its commit
	const actor = { kind: 'system' as const, run: instance.id, by: { automation: `${integration}.webhook` } };
	const authority = yield* identity.authority({ actor, policies, admin: false });
	let acts = 0;
	const bridge: Bridge = {
		cross: (batch) =>
			Effect.gen(function* () {
				const requests = batch.flatMap((call) => (call._tag === 'read' ? [call.read] : []));
				const answers = yield* reads.run(requests, { as: 'caller', authority }, b, 'Server').pipe(
					Effect.map((values) => values.map((value): CrossAnswer => ({ ok: true, value }))),
					Effect.catch((error) =>
						Effect.succeed(requests.map(() => cross_failure(error._tag === 'BoltError' ? error.code : 'internal', error.message)))
					)
				);
				let index = 0;
				return yield* Effect.forEach(batch, (call): Effect.Effect<CrossAnswer> => {
					if (call._tag === 'read')
						return Effect.succeed(answers[index++] ?? cross_failure('internal', 'the read returned no answer'));
					if (call._tag !== 'act')
						return Effect.succeed(cross_failure('unsupported', `a webhook handler cannot ${call._tag}`));
					const key = call.options.key ?? `${id}:${acts++}`;
					return calls
						.acts({
							name: 'act',
							acts: call.acts,
							outputs: call.outputs,
							key,
							issuedAt: b.now,
							authority,
							bindings: b,
							invocationId: key,
							from: 'Server'
						})
						.pipe(
							Effect.map((result): CrossAnswer => ({ ok: true, value: result.outcome })),
							Effect.catch((error) =>
								Effect.succeed(cross_failure(error._tag === 'BoltError' ? error.code : 'internal', error.message))
							)
						);
				});
			})
	};
	const outcome = yield* guest.invoke(
		{
			id,
			kind: 'webhook',
			target: `integration_definition.${integration}.bodies.webhook`,
			input: [request, { $ctx: true }],
			ctx: { actor, now: b.now, today: b.today, tz: b.tz, seed: id, instance: instance.id, configuration: instance.configuration },
			budget: { crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes }
		},
		bridge
	);
	if (outcome.kind === 'refused') return Response.json({ error: { code: outcome.code ?? 'refused', message: outcome.message } }, { status: 422 });
	if (outcome.kind === 'failed') {
		yield* Effect.logWarning(`The webhook handler of ${integration} failed.`, outcome.error);
		return new Response(null, { status: 500 });
	}
	const reply = Schema.decodeUnknownOption(Reply)(outcome.output);
	if (reply._tag === 'None') return new Response(null, { status: 500 });
	const status = reply.value?.status ?? 200,
		body = reply.value?.body;
	return body === undefined
		? new Response(null, { status })
		: Predicate.isString(body)
			? new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
			: Response.json(body, { status });
});
