// `ctx.convert.record`: a record printed as the shell shows it, by the host's browser (`RenderPort`), under the run's
// own identity. The page reads as that identity through a render grant: a bearer token held in this generation's memory
// only while the print runs, honoured for reads alone (`shell/host.ts`).
import { Context, Effect, Layer, Option, Schema, type Scope } from 'effect';
import { default_fields, exposure_of } from '@norbital-ai/store';
import { FacilityFailure, type PortFailure } from '@norbital-ai/host-api';
import type { Json } from '../decl/values.ts';
import { request, type ReadIR } from '../protocol/reads.ts';
import { catalog_of } from './access/pred.ts';
import { LIMITS, type Authority, type CrossAnswer } from './contracts.ts';
import type { EngineError } from './errors.ts';
import type { EngineManifest } from './manifest.ts';
import type { Render } from './ports.ts';

/** A render grant's bearer prefix (an API key's is `nbk_`). */
export const RENDER_BEARER = 'nbr_';

/** Render grants of this generation: `grant` holds one for its scope; `of` answers its authority while held. */
export class RenderGrants extends Context.Service<
	RenderGrants,
	{
		readonly grant: (authority: Authority) => Effect.Effect<string, never, Scope.Scope>;
		readonly of: (token: string) => Authority | undefined;
	}
>()('bolt/RenderGrants') {
	static readonly layer = Layer.effect(
		RenderGrants,
		Effect.sync(() => {
			const held = new Map<string, Authority>();
			return {
				grant: (authority: Authority) =>
					Effect.acquireRelease(
						Effect.sync(() => {
							const token = `${RENDER_BEARER}${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`.replaceAll('-', '');
							held.set(token, { ...authority, render: true });
							return token;
						}),
						(token) => Effect.sync(() => void held.delete(token))
					),
				of: (token: string) => held.get(token)
			};
		})
	);
}

/** The shell's print route for one record: its view alone, signalling when its reads settle (`RecordPrint.svelte`). */
export const print_path = (model: string, id: string) =>
	`/?record=${encodeURIComponent(model)}/${encodeURIComponent(id)}&print`;

const Args = Schema.Tuple([
	Schema.String,
	Schema.String,
	Schema.Struct({ to: Schema.Literal('pdf'), name: Schema.optionalKey(Schema.String) })
]);
const invalid = (message: string) => Effect.fail(FacilityFailure.invalid(message));

/**
 * One `convert.record` call: the record must be one the run's identity reads (`read`, the run's own reads), then the
 * host prints its print route under a render grant. Answers the bytes as a `TransientFile`; nothing is stored.
 */
export const render_record = (
	ports: {
		readonly manifest: EngineManifest;
		readonly render: Render['Service'];
		readonly grants: RenderGrants['Service'];
	},
	args: readonly Json[],
	authority: Authority,
	read: (requests: readonly ReadIR[]) => Effect.Effect<readonly Json[], EngineError>
): Effect.Effect<CrossAnswer, PortFailure> =>
	Effect.gen(function* () {
		const decoded = Schema.decodeUnknownOption(Args)(args);
		if (Option.isNone(decoded))
			return yield* invalid("convert.record takes (model, id, { to: 'pdf', name? })");
		const [model, id, options] = decoded.value;
		const m = ports.manifest;
		if (m.models[model] === undefined) return yield* invalid(`no model '${model}'`);
		if (!m.workspace.convert?.to.includes('pdf'))
			return yield* invalid("'pdf' is not declared in workspace.convert.to");
		// the identity's own read of the row: a record it cannot read is never printed
		const catalog = catalog_of(m);
		const readable = yield* Effect.gen(function* () {
			const output = yield* exposure_of(catalog, model);
			const ir = yield* request(catalog, {
				[model]: { output: 'default', fields: default_fields(output, true), where: { id: { in: [id] } }, limit: 1 }
			});
			const [answer] = yield* read([ir]);
			const page = Schema.decodeUnknownOption(
				Schema.Record(Schema.String, Schema.Struct({ rows: Schema.Array(Schema.Unknown) }))
			)(answer);
			return Option.exists(page, (pages) => (pages[model]?.rows.length ?? 0) > 0);
		}).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!readable) return yield* invalid(`no ${model} '${id}' this run may read`);
		const bytes = yield* Effect.scoped(
			Effect.flatMap(ports.grants.grant(authority), (token) =>
				ports.render.pdf({ path: print_path(model, id), authorization: `Bearer ${token}` })
			)
		);
		if (bytes.byteLength > LIMITS.crossingBytes)
			return yield* Effect.fail(
				new FacilityFailure({ kind: 'too_large', message: `the printed ${model} is over ${LIMITS.crossingBytes} bytes` })
			);
		return {
			ok: true,
			value: { name: options.name ?? `${model}-${id}.pdf`, mime: 'application/pdf', bytes: { $bin: 0 } },
			bins: [bytes]
		} satisfies CrossAnswer;
	});
