// One file read to one answer, then this process ends: the server's `spawned` starts it (job.ts).
import { Effect, Schema } from 'effect';
import { ingester } from './ingest.ts';
import { readTo } from './job.ts';
import { transcriber } from './transcribe.ts';

const Job = Schema.fromJsonString(
	Schema.Struct({
		name: Schema.String,
		mime: Schema.String,
		path: Schema.String,
		out: Schema.String,
		options: Schema.optionalKey(
			Schema.Struct({
				diarize: Schema.optionalKey(Schema.Boolean),
				language: Schema.optionalKey(Schema.String),
				speakers: Schema.optionalKey(Schema.Number),
				prompt: Schema.optionalKey(Schema.String),
				pictures: Schema.optionalKey(Schema.Boolean),
				page: Schema.optionalKey(Schema.Number)
			})
		)
	})
);
const env = process.env,
	apiKey = env['CONVERT_AI_API_KEY'],
	model = env['CONVERT_TRANSCRIBE_MODEL'],
	transcribe =
		apiKey && model
			? transcriber({ baseUrl: env['CONVERT_AI_BASE_URL'] ?? 'https://openrouter.ai/api/v1', apiKey, model })
			: undefined;
await Effect.runPromise(
	Schema.decodeUnknownEffect(Job)(process.argv[2]).pipe(
		Effect.mapError((failure) => new Error(failure.message)),
		Effect.flatMap(readTo(ingester(transcribe ? { transcribe } : {})))
	)
).catch((failure: unknown) => {
	console.error(failure instanceof Error ? failure.message : String(failure));
	process.exit(1);
});
