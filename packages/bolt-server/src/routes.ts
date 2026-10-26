import { Clock, Effect, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { verifyOp } from '@norbital-ai/std/host-op';
import {
	BoltError,
	HostIdentity,
	TenantDb,
	founderBootstrap,
	mint
} from '@norbital-ai/bolt/engine';
import type { Config } from './config.ts';
const Input = Schema.Union([
	Schema.Struct({
		op: Schema.Literal('host.ping'),
		input: Schema.Record(Schema.String, Schema.Json).pipe(
			Schema.withDecodingDefault(Effect.succeed({}))
		),
		runId: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		op: Schema.Literal('session.mint'),
		input: Schema.Struct({ user: Schema.String }),
		runId: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		op: Schema.Literal('founder.bootstrap'),
		input: Schema.Struct({ address: Schema.String, name: Schema.optionalKey(Schema.String) }),
		runId: Schema.optionalKey(Schema.String)
	})
]);
export const ops = (config: Config, handle: string, request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		if (config.opsKey === null)
			return HttpServerResponse.jsonUnsafe(
				{
					error: {
						code: 'unavailable',
						message: 'Host operations are not configured (BOLT_OPS_KEY).'
					}
				},
				{ status: 503 }
			);
		const db = yield* TenantDb,
			bytes = new Uint8Array(yield* request.arrayBuffer);
		const web = yield* HttpServerRequest.toWeb(request),
			operation = yield* verifyOp({ secret: config.opsKey, scope: handle }, web, bytes, {
				claim: (nonce, at) =>
					db
						.write({
							text: 'INSERT INTO bolt_host_nonce (key,at) VALUES ($1,$2::timestamptz) ON CONFLICT (key) DO NOTHING RETURNING key',
							params: [`nonce:${nonce}`, new Date(at).toISOString()]
						})
						.pipe(Effect.map((result) => result.rows.length === 1))
			});
		const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(
			new TextDecoder().decode(bytes)
		).pipe(
			Effect.mapError((cause) =>
				BoltError.make('invalid', 'decode', 'The host operation is malformed.', cause)
			)
		);
		if (decoded.op !== operation)
			return yield* Effect.fail(
				BoltError.make('forbidden', 'admission', 'The signed operation and body differ.')
			);
		if (decoded.runId !== undefined) {
			const once = yield* db.write({
				text: 'INSERT INTO bolt_host_nonce (key,at) VALUES ($1,now()) ON CONFLICT (key) DO NOTHING RETURNING key',
				params: [`run:${decoded.runId}`]
			});
			if (once.rows.length !== 1)
				return HttpServerResponse.jsonUnsafe(
					{ error: { code: 'replayed', message: 'The operation run was already used.' } },
					{ status: 409 }
				);
		}
		const identity = yield* HostIdentity;
		switch (decoded.op) {
			case 'host.ping':
				return HttpServerResponse.jsonUnsafe({
					value: { workspace: handle, at: new Date(yield* Clock.currentTimeMillis).toISOString() }
				});
			case 'session.mint':
				return HttpServerResponse.jsonUnsafe({ value: yield* mint(identity, decoded.input.user) });
			case 'founder.bootstrap':
				return HttpServerResponse.jsonUnsafe({
					value: yield* founderBootstrap(identity, decoded.input.address, decoded.input.name)
				});
		}
	}).pipe(
		Effect.catchTag('OpRefused', (error) =>
			Effect.succeed(
				HttpServerResponse.jsonUnsafe(
					{
						error: {
							code: error.reason === 'replayed' ? 'replayed' : 'forbidden',
							message: 'The operation signature was refused.'
						}
					},
					{ status: error.reason === 'replayed' ? 409 : 403 }
				)
			)
		)
	);
