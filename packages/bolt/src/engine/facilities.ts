import { Clock, Effect, Layer, Option, Schema } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';
import { PAPER_SIZES, type ConvertSource, type PreviewPdfOptions } from '../decl/runtime/facilities.ts';
import {
	LIMITS,
	facility_wall_ms,
	CONVERT_MIME,
	CONVERT_TARGETS,
	type CrossAnswer,
	type EmbedInput
} from './contracts.ts';
import type { EngineManifest } from './manifest.ts';
import { TenantDb, type TenantDbShape } from './db/tenant-db.ts';
import { Ai, Browser, Convert, Files, Geo, Images, Transport, WebRead } from './ports.ts';
import { Port, type PortFailure } from './port.ts';
import { Decisions, Facilities, Manifest, type FacilityCall } from './services.ts';
import { image_facts, image_jpeg } from './files/image.ts';
import { size_bytes } from './callables/upload.ts';
import { sha256_hex } from '@norbital-ai/store';
import { DecisionRequestSchema } from './decision.ts';
import { infer_facility } from './agent/ai.ts';
import { indexOf, transcriptOf } from './agent/ingest.ts';
import { PATHS } from '../protocol/wire.ts';
import { BrowserStepSchema } from '../decl/runtime/browser.ts';

const BrowserSteps = Schema.Array(BrowserStepSchema);

const FileRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	mime: Schema.String,
	size: Schema.Number,
	key: Schema.String,
	sha256: Schema.String,
	field: Schema.String
});
type FileRow = typeof FileRow.Type;
const PutOptions = Schema.Struct({ name: Schema.String, mime: Schema.String, for: Schema.String });
/** A FileRef as a facility takes it: its `id` names the stored file. */
export const Reference = Schema.Struct({ id: Schema.String });
/** `files.image` options: with `jpeg`, a JPEG copy no larger than `max_edge` is stored; without, the image's facts. */
export const ImageOptions = Schema.Struct({
	jpeg: Schema.optionalKey(
		Schema.Struct({ max_edge: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 8192 })) })
	)
});
/** `ai.embed` inputs: text, or stored files by FileRef. */
export const EmbedInputs = Schema.Array(
	Schema.Union([
		Schema.String,
		Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
	])
);
const answered = (value: Json): CrossAnswer => ({ ok: true, value });
const wireError = (error: PortFailure): CrossAnswer => ({
	ok: false,
	error:
		error._tag === 'Unavailable'
			? { kind: 'unavailable', facility: error.facility, reason: error.reason }
			: {
					kind: error.kind,
					message: error.message,
					...(error.status === undefined ? {} : { status: error.status })
				}
});
const decode = <A>(schema: Schema.Decoder<A>, value: unknown, message: string) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => FacilityFailure.invalid(message)));
const databaseFailure = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : 'a stored file could not be read'
	});
const refOf = (row: FileRow): Json => ({
	id: row.id,
	name: row.name,
	mime: row.mime,
	bytes: row.size,
	sha256: row.sha256
});
const stored_file = (db: TenantDbShape, id: string) =>
	db.one(FileRow, {
		text: `SELECT id, name, mime, size, key, sha256, coalesce(field, '') AS field FROM sys_file WHERE id = $1`,
		params: [id]
	}).pipe(
		Effect.mapError(databaseFailure),
		Effect.flatMap((row) => Option.isNone(row) ? Effect.fail(FacilityFailure.invalid(`no file '${id}'`)) : Effect.succeed(row.value))
	);

const file_loader =
	(db: TenantDbShape, files: Files['Service']) =>
	(
		fileId: string
	): Effect.Effect<{ readonly mime: string; readonly bytes: Uint8Array }, PortFailure> =>
		Effect.gen(function* () {
			const found = yield* stored_file(db, fileId);
			return {
				mime: found.mime,
				bytes: yield* files
					.get(found.key, LIMITS.storedFileBytes)
					.pipe(Port.call('files', LIMITS.callMs.other))
			};
		});

/** A stored file's FileRef as the wire carries it. */
export type StoredFile = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly bytes: number;
	readonly sha256: string;
};
const ownerOf = (owner: string, ports: Pick<FacilityPorts, 'manifest'>, via: string) =>
	owner in ports.manifest.automations || owner.includes('.')
		? Effect.void
		: Effect.fail(FacilityFailure.invalid(`${via}: for names a field or automation`));
/** A blob already in the store as a `sys_file`. */
const recordFile = (
	ports: Pick<FacilityPorts, 'db'>,
	blob: { readonly key: string; readonly sha256: string; readonly bytes: number },
	file: {
		readonly name: string;
		readonly mime: string;
		readonly for: string;
		readonly by?: string | undefined;
	}
) =>
	Effect.gen(function* () {
		const now = new Date(yield* Clock.currentTimeMillis).toISOString(),
			id = globalThis.crypto.randomUUID();
		yield* ports.db
			.write({
				text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`,
				params: [
					id,
					file.name,
					file.mime,
					blob.bytes,
					blob.key,
					blob.sha256,
					file.for,
					now,
					file.by ?? null
				]
			})
			.pipe(Effect.mapError(databaseFailure));
		return { id, name: file.name, mime: file.mime, bytes: blob.bytes, sha256: blob.sha256 };
	});
/**
 * Stores `bytes` as a `sys_file` of at most `max` bytes, owned by `for`: a model's file field (`<model>.<field>`), an
 * automation, or a member's own file (`<model>.$export.<sync>`, `bolt.$export`), which only `by` downloads.
 */
export const storeFile =
	(ports: Pick<FacilityPorts, 'db' | 'manifest' | 'files'>) =>
	(
		bytes: Uint8Array,
		file: {
			readonly name: string;
			readonly mime: string;
			readonly for: string;
			readonly by?: string | undefined;
		},
		via: string,
		max: number = LIMITS.fileBytes
	): Effect.Effect<StoredFile, PortFailure> =>
		Effect.gen(function* () {
			if (bytes.byteLength > max)
				return yield* Effect.fail(
					new FacilityFailure({ kind: 'too_large', message: `${via} wrote over ${max} bytes` })
				);
			yield* ownerOf(file.for, ports, via);
			const blob = yield* ports.files
				.put(bytes, { name: file.name, mime: file.mime })
				.pipe(Port.call('files', LIMITS.callMs.other));
			return yield* recordFile(
				ports,
				{ key: blob.key, sha256: sha256_hex(bytes), bytes: bytes.byteLength },
				file
			);
		});

/** `convert.document`'s options as a guest sends them (a guest never names `by`). */
const DocumentRequest = Schema.Struct({
	to: Schema.Literals(CONVERT_TARGETS),
	name: Schema.String,
	for: Schema.String,
	page: Schema.optionalKey(Schema.Literals(PAPER_SIZES)),
	landscape: Schema.optionalKey(Schema.Boolean),
	reference: Schema.optionalKey(Reference)
});
const Source = Schema.Union([
	Schema.Struct({ markdown: Schema.String }),
	Schema.Struct({ html: Schema.String }),
	Schema.Struct({ layout_html: Schema.String })
]);
/** A conversion: a declared target, its file name and options, the owner `for` and, for a member's own file, `by`. */
export type DocumentRequest = typeof DocumentRequest.Type & { readonly by?: string | undefined };
/** One conversion through the host's converter, stored like `files.put`: the target must be declared and served. */
const convertWith =
	(ports: Pick<FacilityPorts, 'db' | 'manifest' | 'files' | 'convert'>) =>
	(source: ConvertSource, request: DocumentRequest): Effect.Effect<StoredFile, PortFailure> =>
		Effect.gen(function* () {
			if (!ports.manifest.workspace.convert?.to.includes(request.to))
				return yield* Effect.fail(
					FacilityFailure.invalid(`'${request.to}' is not declared in workspace.convert.to`)
				);
			if ('layout_html' in source && request.to !== 'pdf')
				return yield* Effect.fail(FacilityFailure.invalid('Layout HTML can only be converted to PDF'));
			if (request.to !== 'pdf' && (request.page !== undefined || request.landscape !== undefined))
				return yield* Effect.fail(FacilityFailure.invalid("page and landscape are a pdf's options"));
			if (request.reference !== undefined && !['docx', 'pptx', 'odt'].includes(request.to))
				return yield* Effect.fail(FacilityFailure.invalid(`${request.to} takes no reference document`));
			if (!ports.convert.targets.includes(request.to))
				return yield* Port.unavailable('convert', `the host provides no ${request.to} converter`);
			const reference =
				request.reference === undefined
					? undefined
					: (yield* file_loader(ports.db, ports.files)(request.reference.id)).bytes;
			const bytes = yield* ports.convert.convert(source, request.to, {
				...(reference === undefined ? {} : { reference }),
				...(request.page === undefined ? {} : { page: request.page }),
				...(request.landscape === undefined ? {} : { landscape: request.landscape })
			});
			return yield* storeFile(ports)(
				bytes,
				{ name: request.name, mime: CONVERT_MIME[request.to], for: request.for, by: request.by },
				'convert.document'
			);
		});
/**
 * H5, the one converter: `source` to `request.to`, stored for `request.for` within the convert wall. `ctx.convert.document`,
 * a notice attachment at delivery and a file sync's
 * document export all convert here.
 */
export const convertDocument = Effect.fn('convertDocument')(function* (
	source: ConvertSource,
	request: DocumentRequest
) {
	const ports = {
		db: yield* TenantDb,
		manifest: yield* Manifest,
		files: yield* Files,
		convert: yield* Convert
	};
	return yield* convertWith(ports)(source, request).pipe(
		Port.call('convert.document', LIMITS.callMs.database)
	);
});

export const previewPdf = Effect.fn('previewPdf')(function* (
	source: ConvertSource,
	options: PreviewPdfOptions
) {
	if (!(yield* Manifest).workspace.convert?.to.includes('pdf'))
		return yield* Effect.fail(FacilityFailure.invalid("'pdf' is not declared in workspace.convert.to"));
	const convert = yield* Convert;
	if (!convert.targets.includes('pdf') || convert.previewPdf === undefined)
		return yield* Port.unavailable('convert', 'the host provides no transient PDF renderer');
	const bytes = yield* convert
		.previewPdf(source, options)
		.pipe(Port.call('convert.previewPdf', LIMITS.callMs.database));
	if (bytes.byteLength > LIMITS.crossingBytes)
		return yield* Effect.fail(
			new FacilityFailure({ kind: 'too_large', message: 'The PDF is too large.' })
		);
	return bytes;
});

const logged_transport = (
	kind: string,
	log: (line: string) => void
): Transport['Service'] => ({
	send: (message) =>
		Effect.sync(() => {
			const provider_id = globalThis.crypto.randomUUID();
			log(`[${kind}] ${JSON.stringify(message)}`);
			return { provider_id };
		})
});
type FacilityPorts = {
	readonly db: TenantDbShape;
	readonly manifest: EngineManifest;
	readonly files: Files['Service'];
	readonly images: Images['Service'];
	readonly convert: Convert['Service'];
	readonly web: WebRead['Service'];
	readonly ai: Ai['Service'];
	readonly geo: Geo['Service'];
	readonly browser: Browser['Service'];
	readonly decisions: Decisions['Service'];
};

function facility_dispatch(ports: FacilityPorts): Facilities['Service']['dispatch'] {
	const load = file_loader(ports.db, ports.files);
	const infer = infer_facility(ports.ai, { load });
	const rowOf = (ref: Json | undefined) =>
		decode(Reference, ref, 'a FileRef names its id').pipe(
			Effect.flatMap((reference) => stored_file(ports.db, reference.id))
		);
	const store = (bytes: Uint8Array, name: string, mime: string, owner: string, via: string) =>
		storeFile(ports)(bytes, { name, mime, for: owner }, via).pipe(Effect.map(answered));
	const file = (call: FacilityCall) =>
		Effect.gen(function* () {
			const first = call.args[0],
				options = call.args[1];
			if (call._tag === 'files.put') {
				const bytes = call.bins?.[0];
				if (bytes === undefined) return yield* Effect.fail(FacilityFailure.invalid('files.put takes bytes'));
				const meta = yield* decode(PutOptions, options, 'files.put takes { name, mime, for }');
				return yield* store(bytes, meta.name, meta.mime, meta.for, 'files.put');
			}
			const row = yield* rowOf(first);
			if (call._tag === 'files.meta') return answered(refOf(row));
			if (call._tag === 'files.url')
				return answered(
					yield* ports.files
						.url(row.key, 3_600)
						.pipe(
							Effect.catchTag('Unavailable', () =>
								Effect.succeed(`${PATHS.files}${encodeURIComponent(row.id)}`)
							)
						)
				);
			const bytes = yield* ports.files
				.get(row.key, LIMITS.storedFileBytes)
				.pipe(Port.call('files', LIMITS.callMs.other));
			if (call._tag === 'files.image') {
				const { jpeg } = yield* decode(
					ImageOptions,
					options ?? {},
					'files.image takes { jpeg: { max_edge: 16..8192 } }'
				);
				if (jpeg === undefined)
					return answered({
						...(yield* image_facts(bytes)),
						sha256: sha256_hex(bytes)
					});
				return yield* store(
					yield* image_jpeg(bytes, jpeg.max_edge),
					`${row.name.replace(/\.[^./]*$/, '')}.jpg`,
					'image/jpeg',
					row.field,
					'files.image'
				);
			}
			const { max: asked } = yield* decode(
				Schema.Struct({ max: Schema.optionalKey(Schema.String) }),
				options ?? {},
				'files.get: max is not a size'
			);
			const max = Math.min(
				asked === undefined ? LIMITS.fileBytes : size_bytes(asked),
				LIMITS.fileBytes
			);
			if (!Number.isFinite(max) || max < 0)
				return yield* Effect.fail(FacilityFailure.invalid('files.get: max is not a size'));
			if (row.size > max)
				return yield* Effect.fail(
					new FacilityFailure({
						kind: 'too_large',
						message: `${row.name} holds ${row.size} bytes; files.get reads at most ${max}`
					})
				);
			return { ok: true, value: { $bin: 0 }, bins: [bytes] } satisfies CrossAnswer;
		});
	return (call) =>
		Effect.gen(function* () {
			const [first, given] = call.args;
			switch (call._tag) {
				case 'browser.navigate': {
					const profile = yield* decode(Schema.String, first, 'browser.navigate takes a profile');
					const url = yield* decode(Schema.String, given, 'browser.navigate takes a URL');
					const { find } = yield* decode(
						Schema.Struct({ find: Schema.optionalKey(Schema.String) }),
						call.args[2] ?? {},
						'browser.navigate takes { find? }'
					);
					return answered(yield* ports.browser.navigate(profile, { url }, find));
				}
				case 'browser.snapshot': {
					const profile = yield* decode(Schema.String, first, 'browser.snapshot takes a profile');
					const options = yield* decode(
						Schema.Struct({
							find: Schema.optionalKey(Schema.String),
							from: Schema.optionalKey(Schema.Finite)
						}),
						given ?? {},
						'browser.snapshot takes { find?, from? }'
					);
					return answered(yield* ports.browser.snapshot(profile, options));
				}
				case 'browser.act': {
					const profile = yield* decode(Schema.String, first, 'browser.act takes a profile');
					const steps = yield* decode(BrowserSteps, given, 'browser.act takes steps');
					return answered(yield* ports.browser.act(profile, steps));
				}
				case 'browser.evaluate': {
					const profile = yield* decode(Schema.String, first, 'browser.evaluate takes a profile');
					const expression = yield* decode(
						Schema.String,
						given,
						'browser.evaluate takes an expression'
					);
					return answered(yield* ports.browser.evaluate(profile, expression));
				}
				case 'browser.download': {
					const profile = yield* decode(Schema.String, first, 'browser.download takes a profile');
					const url = yield* decode(Schema.String, given, 'browser.download takes a URL');
					const { for: owner } = yield* decode(
						Schema.Struct({ for: Schema.String }),
						call.args[2],
						'browser.download takes { for }'
					);
					yield* ownerOf(owner, ports, 'browser.download');
					const kept = yield* ports.browser.download(profile, url);
					return answered(
						yield* recordFile(ports, kept, { name: kept.name, mime: kept.mime, for: owner })
					);
				}
				case 'browser.close': {
					const profile = yield* decode(Schema.String, first, 'browser.close takes a profile');
					yield* ports.browser.close(profile);
					return answered(null);
				}
				case 'web.read': {
					const url = yield* decode(Schema.String, first, 'web.read takes a URL');
					const { raw } = yield* decode(
						Schema.Struct({ raw: Schema.optionalKey(Schema.Boolean) }),
						given ?? {},
						'web.read raw is a boolean'
					);
					return answered(yield* ports.web.read(url, raw === undefined ? undefined : { raw }));
				}
				case 'geo.search':
					return answered(
						yield* ports.geo.search(yield* decode(Schema.String, first, 'geo.search takes text'))
					);
				case 'geo.reverse':
					return answered(
						yield* ports.geo.reverse(
							yield* decode(
								Schema.Struct({ lat: Schema.Number, lng: Schema.Number }),
								first,
								'geo.reverse takes { lat, lng }'
							)
						)
					);
				case 'files.meta':
				case 'files.get':
				case 'files.url':
				case 'files.image':
				case 'files.put':
					return yield* file(call);
				case 'ai.sys_2.infer':
					return yield* infer(call);
				case 'ai.sys_1.decide': {
					const request = yield* decode(
						DecisionRequestSchema,
						first,
						'decide takes { state, questions }'
					);
					const result = yield* ports.decisions.decide('author', request);
					const answers: Record<string, Json> = {};
					for (const [id, answer] of Object.entries(result.answers)) {
						const question = request.questions[id];
						if (answer.type === 'score' && question?.type === 'score') {
							const level = question.criteria[answer.level];
							if (level === undefined)
								return yield* Effect.fail(FacilityFailure.invalid('sys_1 answered outside the offered criteria'));
							answers[id] = { ...answer, level };
						} else answers[id] = answer;
					}
					return answered({ answers, cost_usd: result.cost_usd });
				}
				case 'ai.embed': {
					const inputs = yield* decode(EmbedInputs, first, 'embed takes strings or FileRefs');
					const embedding = yield* decode(
						Schema.Struct({
							model: Schema.optionalKey(Schema.String),
							dimensions: Schema.optionalKey(Schema.Number)
						}),
						given ?? {},
						'embed takes { model?, dimensions? }'
					);
					const resolved: EmbedInput[] = [];
					for (const input of inputs) {
						if (typeof input === 'string') resolved.push(input);
						else {
							const row = yield* rowOf(input);
							resolved.push({
								$stored: {
									key: row.key,
									name: row.name,
									mime: row.mime,
									sha256: row.sha256,
									bytes: row.size
								}
							});
						}
					}
					return answered(
						yield* ports.ai.embed(resolved, embedding.model ?? 'default', embedding.dimensions)
					);
				}
				case 'convert.document': {
					const request = yield* decode(
						DocumentRequest,
						given,
						'convert.document takes { to, name, for, page?: A4, A3 or Letter, landscape?, reference? }'
					);
					const source = yield* decode(
						Source,
						first,
						'convert.document takes { markdown } or { html }'
					);
					return answered(yield* convertWith(ports)(source, request));
				}
				case 'convert.ingest': {
					const row = yield* rowOf(first);
					const { for: owner, ...options } = yield* decode(
						Schema.Struct({
							for: Schema.optionalKey(Schema.String),
							password: Schema.optionalKey(Schema.String),
							diarize: Schema.optionalKey(Schema.Boolean),
							language: Schema.optionalKey(Schema.String),
							speakers: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
							prompt: Schema.optionalKey(Schema.String)
						}),
						given ?? {},
						'convert.ingest takes { for?, password?, diarize?, language?, speakers?, prompt? }'
					);
					if (ports.convert.ingest === undefined)
						return yield* Port.unavailable('convert.ingest', 'the host provides no ingest');
					const bytes = yield* ports.files.get(row.key, LIMITS.storedFileBytes);
					const got = yield* ports.convert.ingest(
						{ sha256: row.sha256, name: row.name, mime: row.mime, bytes },
						options
					);
					if ('unsupported' in got)
						return yield* Effect.fail(
							new FacilityFailure({ kind: 'unsupported', message: got.unsupported })
						);
					const images =
						owner === undefined
							? undefined
							: yield* Effect.forEach(got.images, (image) =>
									storeFile(ports)(
										image.bytes,
										{ name: image.name, mime: image.mime, for: owner },
										'convert.ingest'
									)
								);
					const stored = images === undefined ? {} : { images };
					if (got.kind === 'data') return answered({ kind: 'data', json: got.json, ...stored });
					const transcript = transcriptOf(got.html);
					return answered({
						kind: 'document',
						html: got.html,
						index: indexOf(got.html),
						...stored,
						...(transcript === undefined ? {} : { transcript })
					});
				}
			}
		}).pipe(
			Effect.provideService(Images, ports.images),
			// an inference has no wall: its stall window ends it
			<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | FacilityFailure, R> => {
				const wall = facility_wall_ms(call._tag);
				return wall === undefined ? self : Port.call(call._tag, wall)(self);
			},
			Effect.mapError((error): PortFailure =>
				error._tag === 'FacilityFailure' || error._tag === 'Unavailable'
					? error
					: databaseFailure(error)
			),
			Effect.catch((error) => Effect.succeed(wireError(error)))
		);
}

export const FacilitiesLive = Layer.effect(
	Facilities,
	Effect.gen(function* () {
		const db = yield* TenantDb,
			manifest = yield* Manifest,
			files = yield* Files,
			images = yield* Images,
			convert = yield* Convert,
			web = yield* WebRead,
			ai = yield* Ai,
			geo = yield* Geo,
			browser = yield* Browser,
			decisions = yield* Decisions;
		return {
			dispatch: facility_dispatch({
				db,
				manifest,
				files,
				images,
				convert,
				web,
				ai,
				geo,
				browser,
				decisions
			}),
			fileLoader: file_loader(db, files),
			loggedTransport: logged_transport
		};
	})
);
