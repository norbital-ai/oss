import { Clock, Effect, Layer, Option, Schema } from 'effect';
import { csvRows } from '@norbital-ai/std/csv';
import { FacilityFailure } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';
import type { ConvertSource } from '../decl/runtime/facilities.ts';
import {
	LIMITS,
	CONVERT_MIME,
	CONVERT_TARGETS,
	type CrossAnswer,
	type EmbedInput
} from './contracts.ts';
import type { EngineManifest } from './manifest.ts';
import { TenantDb, type TenantDbShape } from './db/tenant-db.ts';
import { Ai, Convert, Files, Geo, Images, Speech, Transport, WebRead } from './ports.ts';
import { Port, type PortFailure } from './port.ts';
import { Decisions, Facilities, Manifest, type FacilityCall } from './services.ts';
import { imageFacts, imageJpeg } from './files/image.ts';
import { sizeBytes } from './callables/upload.ts';
import { xlsxCells, xlsxSheets } from './files/xlsx.ts';
import { sha256Hex } from '@norbital-ai/store';
import { DecisionRequestSchema } from './decisions/index.ts';
import { inferFacility } from './agent/ai.ts';
import { PATHS } from '../protocol/wire.ts';

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
/** `files.image` options: with `jpeg`, a JPEG copy no larger than `maxEdge` is stored; without, the image's facts. */
export const ImageOptions = Schema.Struct({
	jpeg: Schema.optionalKey(
		Schema.Struct({ maxEdge: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 8192 })) })
	)
});
/** `ai.embed` inputs: text, or stored files by FileRef. */
export const EmbedInputs = Schema.Array(
	Schema.Union([
		Schema.String,
		Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
	])
);
const invalid = (message: string) => new FacilityFailure({ kind: 'invalid', message });
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
	Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => invalid(message)));
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

export const fileLoader =
	(db: TenantDbShape, files: Files['Service']) =>
	(
		fileId: string
	): Effect.Effect<{ readonly mime: string; readonly bytes: Uint8Array }, PortFailure> =>
		Effect.gen(function* () {
			const found = yield* db
				.one(FileRow, {
					text: `SELECT id, name, mime, size, key, sha256, coalesce(field, '') AS field FROM sys_file WHERE id = $1`,
					params: [fileId]
				})
				.pipe(Effect.mapError(databaseFailure));
			if (Option.isNone(found)) return yield* Effect.fail(invalid(`no file '${fileId}'`));
			return {
				mime: found.value.mime,
				bytes: yield* files
					.get(found.value.key, LIMITS.storedFileBytes)
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
					new FacilityFailure({ kind: 'tooLarge', message: `${via} wrote over ${max} bytes` })
				);
			if (!(file.for in ports.manifest.automations) && !file.for.includes('.'))
				return yield* Effect.fail(invalid(`${via}: for names a field or automation`));
			const blob = yield* ports.files
				.put(bytes, { name: file.name, mime: file.mime })
				.pipe(Port.call('files', LIMITS.callMs.other));
			const now = new Date(yield* Clock.currentTimeMillis).toISOString(),
				id = globalThis.crypto.randomUUID();
			const sha256 = sha256Hex(bytes);
			yield* ports.db
				.write({
					text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`,
					params: [
						id,
						file.name,
						file.mime,
						bytes.byteLength,
						blob.key,
						sha256,
						file.for,
						now,
						file.by ?? null
					]
				})
				.pipe(Effect.mapError(databaseFailure));
			return { id, name: file.name, mime: file.mime, bytes: bytes.byteLength, sha256 };
		});

/** `convert.document`'s options as a guest sends them (a guest never names `by`). */
const DocumentRequest = Schema.Struct({
	to: Schema.Literals(CONVERT_TARGETS),
	name: Schema.String,
	for: Schema.String,
	page: Schema.optionalKey(Schema.Literals(['A4', 'A3', 'Letter'])),
	landscape: Schema.optionalKey(Schema.Boolean),
	reference: Schema.optionalKey(Reference)
});
const Source = Schema.Union([
	Schema.Struct({ markdown: Schema.String }),
	Schema.Struct({ html: Schema.String })
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
					invalid(`'${request.to}' is not declared in workspace.convert.to`)
				);
			if (request.to !== 'pdf' && (request.page !== undefined || request.landscape !== undefined))
				return yield* Effect.fail(invalid("page and landscape are a pdf's options"));
			if (request.reference !== undefined && !['docx', 'pptx', 'odt'].includes(request.to))
				return yield* Effect.fail(invalid(`${request.to} takes no reference document`));
			if (!ports.convert.targets.includes(request.to))
				return yield* Port.unavailable('convert', `the host provides no ${request.to} converter`);
			const reference =
				request.reference === undefined
					? undefined
					: (yield* fileLoader(ports.db, ports.files)(request.reference.id)).bytes;
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
 * a page's `bolt.convert` (`for: 'bolt.$export'`, `by` the viewer), a notice attachment at delivery and a file sync's
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

export const loggedTransport = (
	kind: string,
	log: (line: string) => void
): Transport['Service'] => ({
	send: (message) =>
		Effect.sync(() => {
			const providerId = globalThis.crypto.randomUUID();
			log(`[${kind}] ${JSON.stringify(message)}`);
			return { providerId };
		})
});
export type FacilityPorts = {
	readonly db: TenantDbShape;
	readonly manifest: EngineManifest;
	readonly files: Files['Service'];
	readonly images: Images['Service'];
	readonly convert: Convert['Service'];
	readonly speech: Speech['Service'];
	readonly web: WebRead['Service'];
	readonly ai: Ai['Service'];
	readonly geo: Geo['Service'];
	readonly decisions: Decisions['Service'];
};

export function facilityDispatch(ports: FacilityPorts): Facilities['Service']['dispatch'] {
	const load = fileLoader(ports.db, ports.files);
	const infer = inferFacility(ports.ai, { load });
	const rowOf = (ref: Json | undefined) =>
		Effect.gen(function* () {
			const reference = yield* decode(Reference, ref, 'a FileRef names its id');
			const row = yield* ports.db
				.one(FileRow, {
					text: `SELECT id, name, mime, size, key, sha256, coalesce(field, '') AS field FROM sys_file WHERE id = $1`,
					params: [reference.id]
				})
				.pipe(Effect.mapError(databaseFailure));
			return Option.isNone(row)
				? yield* Effect.fail(invalid(`no file '${reference.id}'`))
				: row.value;
		});
	const store = (bytes: Uint8Array, name: string, mime: string, owner: string, via: string) =>
		storeFile(ports)(bytes, { name, mime, for: owner }, via).pipe(Effect.map(answered));
	const file = (call: FacilityCall) =>
		Effect.gen(function* () {
			const first = call.args[0],
				options = call.args[1];
			if (call._tag === 'files.put') {
				const bytes = call.bins?.[0];
				if (bytes === undefined) return yield* Effect.fail(invalid('files.put takes bytes'));
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
					'files.image takes { jpeg: { maxEdge: 16..8192 } }'
				);
				if (jpeg === undefined)
					return answered({
						...(yield* imageFacts(bytes)),
						sha256: sha256Hex(bytes)
					});
				return yield* store(
					yield* imageJpeg(bytes, jpeg.maxEdge),
					`${row.name.replace(/\.[^./]*$/, '')}.jpg`,
					'image/jpeg',
					row.field,
					'files.image'
				);
			}
			if (
				call._tag === 'files.text' ||
				call._tag === 'files.table' ||
				call._tag === 'files.sheet'
			) {
				if (
					call._tag !== 'files.text' &&
					(row.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
						row.name.endsWith('.xlsx'))
				) {
					if (call._tag === 'files.table')
						return answered(
							xlsxCells(bytes).map((cells) =>
								cells.map((cell) => (cell === null ? '' : String(cell)))
							)
						);
					const names = xlsxSheets(bytes);
					return answered(names.map((name, index) => ({ name, rows: xlsxCells(bytes, index) })));
				}
				if (!/^(text\/|application\/(json|xml|csv)\b)/.test(row.mime))
					return yield* Effect.fail(invalid(`files.text reads text; ${row.name} is ${row.mime}`));
				const text = yield* Effect.try({
					try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
					catch: () => invalid(`${row.name} is not UTF-8 text`)
				});
				const rows = csvRows(text);
				return answered(
					call._tag === 'files.text'
						? text
						: call._tag === 'files.sheet'
							? [{ name: row.name, rows }]
							: rows
				);
			}
			const { max: asked } = yield* decode(
				Schema.Struct({ max: Schema.optionalKey(Schema.String) }),
				options ?? {},
				'files.get: max is not a size'
			);
			const max = Math.min(
				asked === undefined ? LIMITS.fileBytes : sizeBytes(asked),
				LIMITS.fileBytes
			);
			if (!Number.isFinite(max) || max < 0)
				return yield* Effect.fail(invalid('files.get: max is not a size'));
			if (row.size > max)
				return yield* Effect.fail(
					new FacilityFailure({
						kind: 'tooLarge',
						message: `${row.name} holds ${row.size} bytes; files.get reads at most ${max}`
					})
				);
			return { ok: true, value: { $bin: 0 }, bins: [bytes] } satisfies CrossAnswer;
		});
	return (call) =>
		Effect.gen(function* () {
			const [first, given] = call.args;
			switch (call._tag) {
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
				case 'files.text':
				case 'files.table':
				case 'files.sheet':
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
								return yield* Effect.fail(invalid('sys_1 answered outside the offered criteria'));
							answers[id] = { ...answer, level };
						} else answers[id] = answer;
					}
					return answered({ answers, costUsd: result.costUsd });
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
				case 'ai.transcribe': {
					const row = yield* rowOf(first);
					const bytes = yield* ports.files.get(row.key, LIMITS.storedFileBytes);
					const spec = yield* decode(
						Schema.Struct({
							diarize: Schema.optionalKey(Schema.Boolean),
							language: Schema.optionalKey(Schema.String),
							speakers: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
							prompt: Schema.optionalKey(Schema.String)
						}),
						given ?? {},
						'transcribe options are invalid'
					);
					return answered(
						yield* ports.speech.transcribe({ name: row.name, mime: row.mime, bytes }, spec)
					);
				}
				case 'ai.speak': {
					const text = yield* decode(Schema.String, first, 'speak takes text');
					const spec = yield* decode(
						Schema.Struct({
							for: Schema.String,
							name: Schema.optionalKey(Schema.String),
							voice: Schema.optionalKey(Schema.String),
							format: Schema.optionalKey(Schema.Literals(['mp3', 'wav', 'ogg'])),
							language: Schema.optionalKey(Schema.String)
						}),
						given,
						'speak takes { for, name?, voice?, format?, language? }'
					);
					const audio = yield* ports.speech.speak(text, {
						format: spec.format ?? 'mp3',
						...(spec.voice === undefined ? {} : { voice: spec.voice }),
						...(spec.language === undefined ? {} : { language: spec.language })
					});
					return yield* store(
						audio.bytes,
						spec.name ?? `speech.${spec.format ?? 'mp3'}`,
						audio.mime,
						spec.for,
						'ai.speak'
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
			}
		}).pipe(
			Effect.provideService(Images, ports.images),
			// an inference has no wall: its stall window ends it (compute model §3 "Limits and liveness")
			<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | FacilityFailure, R> =>
				call._tag === 'ai.sys_2.infer'
					? self
					: Port.call(
							call._tag,
							call._tag === 'ai.transcribe' || call._tag === 'ai.speak'
								? LIMITS.callMs.speech
								: call._tag === 'files.image'
									? LIMITS.callMs.image
									: call._tag.startsWith('ai.')
										? LIMITS.callMs.ai
										: call._tag === 'convert.document'
											? LIMITS.callMs.database
											: LIMITS.callMs.other
						)(self),
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
			speech = yield* Speech,
			web = yield* WebRead,
			ai = yield* Ai,
			geo = yield* Geo,
			decisions = yield* Decisions;
		return {
			dispatch: facilityDispatch({
				db,
				manifest,
				files,
				images,
				convert,
				speech,
				web,
				ai,
				geo,
				decisions
			}),
			fileLoader: fileLoader(db, files),
			loggedTransport
		};
	})
);
