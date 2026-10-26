import { Schema } from 'effect';
import { Diagnostic } from '../../protocol/diagnostic.ts';

const boundedText = Schema.String.check(Schema.isMaxLength(200));
/** The administrator's monitoring scope. No source paths, code or mutation is accepted here. */
export const StudioInspectInput = Schema.Struct({
	range: Schema.Literals(['24h', '7d', '30d']),
	/** The pane the reader is looking at; the host answers the shared snapshot all four read. */
	view: Schema.optionalKey(Schema.Literals(['resources', 'logs', 'activity', 'users'])),
	build: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
	run: Schema.optionalKey(Schema.NullOr(boundedText)),
	level: Schema.optionalKey(Schema.NullOr(Schema.Literals(['info', 'warn', 'error']))),
	text: Schema.optionalKey(Schema.NullOr(boundedText))
});
export type StudioInspectInput = typeof StudioInspectInput.Type;

const number = Schema.Number.check(Schema.isFinite());
const count = number.check(Schema.isGreaterThanOrEqualTo(0));
const optionalText = Schema.optionalKey(Schema.String);
const line = Schema.Struct({
	at: Schema.String,
	level: Schema.Literals(['info', 'warn', 'error']),
	message: Schema.String
});
const diagnostic = Schema.Struct({
	...Diagnostic.fields,
	severity: Schema.optionalKey(Schema.Literals(['error', 'warn']))
});
const build = Schema.Struct({
	commit: Schema.String,
	at: Schema.String,
	status: Schema.Literals(['built', 'failed']),
	message: Schema.String,
	deployed: Schema.Boolean,
	live: Schema.Boolean,
	lines: count,
	diagnostics: count
});
const release = Schema.Struct({
	commit: Schema.String,
	at: Schema.String,
	message: Schema.String,
	current: Schema.Boolean,
	checkpoint: Schema.optionalKey(Schema.NullOr(Schema.String)),
	rollback: optionalText,
	undo: Schema.optionalKey(Schema.Literal(true)),
	discards: optionalText,
	replaced: Schema.optionalKey(Schema.Literal(true))
});
const preview = Schema.Struct({
	url: Schema.NullOr(Schema.String),
	commit: Schema.String,
	artifact: Schema.String,
	stale: Schema.Boolean,
	shelved: Schema.optionalKey(Schema.Boolean),
	destructive: Schema.optionalKey(Schema.Array(Schema.String))
});
const change = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	state: Schema.Literals(['open', 'merged', 'closed']),
	head: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	behind: Schema.optionalKey(count),
	merge: Schema.optionalKey(
		Schema.Struct({
			state: Schema.Literals(['running', 'failed']),
			at: Schema.String,
			head: Schema.String,
			error: optionalText
		})
	),
	preview: Schema.NullOr(preview)
});
const chart = Schema.Struct({
	title: Schema.String,
	unit: Schema.String,
	lines: Schema.Array(
		Schema.Struct({
			label: Schema.String,
			bound: Schema.Boolean,
			points: Schema.Array(Schema.Struct({ at: number, value: Schema.NullOr(number) }))
		})
	),
	utilization: Schema.NullOr(number)
});
const asset = Schema.Struct({
	path: Schema.String,
	sha256: Schema.String,
	bytes: Schema.NullOr(count)
});
const log = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	severity: Schema.Literals(['info', 'warn', 'error']),
	event: Schema.String,
	invocation: Schema.String,
	run: Schema.NullOr(Schema.String),
	conversation: Schema.NullOr(Schema.String),
	turn: Schema.NullOr(Schema.String),
	attributes: Schema.Json
});
const message = Schema.NullOr(Schema.String);
/** Curated host diagnostics shared by the tenant Studio and Realm; never source, manifests or credentials. */
export const StudioInspection = Schema.Struct({
	/** Proven administrator capability is independent of whether member activity could be measured. */
	canInspect: Schema.Boolean,
	asOf: Schema.String,
	usage: Schema.Array(chart),
	members: Schema.NullOr(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				email: Schema.NullOr(Schema.String),
				active: Schema.Boolean,
				lastSeen: Schema.NullOr(Schema.String)
			})
		)
	),
	studio: Schema.NullOr(
		Schema.Struct({
			commit: Schema.String,
			message: Schema.String,
			builds: Schema.Array(build),
			releases: Schema.Array(release),
			environments: Schema.Array(
				Schema.Struct({
					name: Schema.String,
					release: Schema.String,
					url: Schema.NullOr(Schema.String)
				})
			),
			changes: Schema.Array(change),
			log: Schema.Array(line),
			diagnostics: Schema.Array(diagnostic),
			build: Schema.NullOr(
				Schema.Struct({ build, log: Schema.Array(line), diagnostics: Schema.Array(diagnostic) })
			)
		})
	),
	logs: Schema.NullOr(Schema.Array(log)),
	bundles: Schema.NullOr(
		Schema.Struct({
			commit: Schema.NullOr(Schema.String),
			live: Schema.Boolean,
			name: Schema.String,
			digest: Schema.String,
			contentAddress: message,
			contract: Schema.String,
			schema: Schema.String,
			assetCount: Schema.NullOr(count),
			assets: Schema.Array(asset),
			truncated: Schema.Boolean,
			totalBytes: Schema.NullOr(count)
		})
	),
	cache: Schema.NullOr(
		Schema.Struct({
			budgetBytes: count,
			hostBytes: count,
			hostEntries: count,
			releaseBytes: count,
			releaseEntries: count,
			assets: Schema.Array(
				Schema.Struct({
					path: Schema.String,
					sha256: Schema.String,
					cachedBytes: count,
					variants: Schema.Array(
						Schema.Struct({ encoding: Schema.Literals(['identity', 'br', 'gzip']), bytes: count })
					)
				})
			)
		})
	),
	errors: Schema.NullOr(
		Schema.Struct({
			access: message,
			studio: message,
			logs: message,
			bundles: message,
			cache: message,
			build: message
		})
	),
	health: Schema.optionalKey(
		Schema.Struct({
			artifactBytes: Schema.NullOr(count),
			fileCount: Schema.NullOr(count),
			packages: Schema.Array(
				Schema.Struct({
					name: Schema.String,
					version: Schema.String,
					source: Schema.Literals(['artifact', 'runtime'])
				})
			),
			errors: Schema.Array(Schema.String),
			cleanup: Schema.Array(
				Schema.Struct({
					changeId: Schema.String,
					title: Schema.String,
					state: Schema.Literals(['open', 'merged', 'closed']),
					environment: Schema.String,
					status: Schema.Literals(['active', 'shelved', 'cleared', 'leftover', 'unknown']),
					reason: Schema.String
				})
			)
		})
	),
	filters: Schema.Struct({
		level: Schema.NullOr(Schema.Literals(['info', 'warn', 'error'])),
		text: Schema.String,
		run: Schema.String,
		build: Schema.NullOr(Schema.String)
	})
});
export type StudioInspection = typeof StudioInspection.Type;
