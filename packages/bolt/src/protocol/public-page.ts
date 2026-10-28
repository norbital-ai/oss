import { Effect, Schema } from 'effect';
import type { Kind, OutputKind } from '@norbital-ai/std/kind';
import type { Json } from '../decl/values.ts';
import type { ShellBoot } from '../shell/nav.ts';

const optionalString = Schema.optionalKey(Schema.String);
const strings = Schema.Array(Schema.String);
const trueKey = Schema.optionalKey(Schema.Literal(true));
const common = {
	optional: trueKey,
	default: Schema.optionalKey(Schema.Json),
	unique: trueKey,
	label: optionalString,
	help: optionalString,
	hidden: trueKey
};
const range = { min: Schema.optionalKey(Schema.Number), max: Schema.optionalKey(Schema.Number) };
const datePrecision = Schema.Literals(['year', 'month', 'week', 'day']);
const precision = Schema.Literals(['year', 'month', 'week', 'day', 'hour', 'minute']);
const predicate = Schema.Record(Schema.String, Schema.Json);
const fields = () => Schema.Record(Schema.String, kind);
const kind: Schema.Codec<Kind, Json> = Schema.suspend(() =>
	Schema.Union([
		Schema.Struct({
			...common,
			kind: Schema.Literal('text'),
			format: Schema.optionalKey(
				Schema.Literals(['email', 'phone', 'url', 'zone', 'markdown', 'cel', 'team'])
			),
			max: Schema.optionalKey(Schema.Number),
			many: trueKey
		}),
		Schema.Struct({ ...common, ...range, kind: Schema.Literal('int') }),
		Schema.Struct({ ...common, ...range, kind: Schema.Literal('number') }),
		Schema.Struct({
			...common,
			...range,
			kind: Schema.Literal('decimal'),
			scale: Schema.Number,
			precision: Schema.optionalKey(Schema.Number)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('money'),
			currency: optionalString,
			scale: Schema.optionalKey(Schema.Number)
		}),
		Schema.Struct({ ...common, kind: Schema.Literal('currency') }),
		Schema.Struct({ ...common, kind: Schema.Literal('bool') }),
		Schema.Struct({ ...common, kind: Schema.Literal('duration') }),
		Schema.Struct({ ...common, kind: Schema.Literal('point') }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('date'),
			precision: Schema.optionalKey(datePrecision)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('instant'),
			precision: Schema.optionalKey(precision)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('time'),
			precision: Schema.optionalKey(Schema.Literals(['hour', 'minute']))
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('period'),
			of: Schema.Literal('date'),
			precision: Schema.optionalKey(datePrecision)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('period'),
			of: Schema.Literal('instant'),
			precision: Schema.optionalKey(precision)
		}),
		Schema.Struct({ ...common, kind: Schema.Literal('enum'), values: strings, many: trueKey }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('state'),
			initial: Schema.String,
			states: Schema.Record(
				Schema.String,
				Schema.Struct({
					to: Schema.optionalKey(strings),
					edit: Schema.optionalKey(Schema.Union([Schema.Literals(['all', 'none']), strings]))
				})
			)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('seq'),
			pattern: optionalString,
			per: Schema.optionalKey(strings)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('sum'),
			of: Schema.String,
			where: Schema.optionalKey(predicate),
			money: Schema.optionalKey(Schema.Struct({ currency: optionalString }))
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('count'),
			of: Schema.String,
			where: Schema.optionalKey(predicate)
		}),
		Schema.Struct({ ...common, kind: Schema.Literal('json'), shape: Schema.optionalKey(kind) }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('file'),
			accept: strings,
			max: Schema.String,
			multiple: trueKey
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('vector'),
			dim: Schema.Number,
			metric: Schema.Literals(['l2', 'cosine', 'ip'])
		}),
		Schema.Struct({ ...common, kind: Schema.Literal('custom'), of: Schema.String, many: trueKey }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('id'),
			of: Schema.String,
			where: Schema.optionalKey(predicate)
		}),
		Schema.Struct({ ...common, ...range, kind: Schema.Literal('list'), of: kind }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('object'),
			fields: fields(),
			rest: Schema.optionalKey(kind)
		}),
		Schema.Struct({
			...common,
			kind: Schema.Literal('union'),
			by: Schema.String,
			arms: Schema.Record(Schema.String, fields())
		}),
		Schema.Struct({ ...common, kind: Schema.Literal('union'), of: Schema.Array(kind) }),
		Schema.Struct({ ...common, kind: Schema.Literal('record'), of: kind })
	])
);
/** Metadata codecs are shared by browser-catalog emission and public hydration. */
export const FieldsSchema = fields();
export const OutputKindSchema: Schema.Codec<OutputKind, Json> = Schema.suspend(() =>
	Schema.Union([
		kind,
		Schema.Struct({ ...common, kind: Schema.Literal('row'), of: Schema.String }),
		Schema.Struct({ ...common, ...range, kind: Schema.Literal('list'), of: OutputKindSchema }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('object'),
			fields: Schema.Record(Schema.String, OutputKindSchema),
			rest: Schema.optionalKey(OutputKindSchema)
		}),
		Schema.Struct({ ...common, kind: Schema.Literal('record'), of: OutputKindSchema }),
		Schema.Struct({
			...common,
			kind: Schema.Literal('union'),
			by: Schema.String,
			arms: Schema.Record(Schema.String, Schema.Record(Schema.String, OutputKindSchema))
		})
	])
);
const SyncExposureSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('file'),
		parser: Schema.optionalKey(
			Schema.Array(
				Schema.Union([Schema.String, Schema.Struct({ type: Schema.String, extensions: strings })])
			)
		),
		import: trueKey,
		export: Schema.optionalKey(strings),
		context: Schema.optionalKey(strings)
	}),
	Schema.Struct({ kind: Schema.Literal('remote'), with: Schema.String })
]);
const childIdentity = { model: Schema.String, parent: Schema.String, owned: trueKey };
const child = Schema.Struct({
	...childIdentity,
	create: Schema.optionalKey(
		Schema.Struct({ columns: strings, filled: Schema.optionalKey(strings), proposalOnly: trueKey })
	),
	update: Schema.optionalKey(Schema.Struct({ columns: strings })),
	delete: trueKey,
	link: trueKey,
	unlink: trueKey
});
const children = Schema.optionalKey(Schema.Record(Schema.String, child));

/** Caller-filtered presentation metadata, decoded without trusting a manifest or arbitrary object cast. */
const PublicCatalog = Schema.Record(
	Schema.String,
	Schema.Struct({
		label: strings,
		search: Schema.optionalKey(strings),
		semantic: trueKey,
		indexes: Schema.optionalKey(
			Schema.Record(Schema.String, Schema.Struct({ input: fields(), description: Schema.String }))
		),
		queries: Schema.optionalKey(
			Schema.Record(
				Schema.String,
				Schema.Struct({ input: fields(), output: OutputKindSchema, description: Schema.String })
			)
		),
		fields: fields(),
		relations: Schema.optionalKey(
			Schema.Record(
				Schema.String,
				Schema.Struct({
					targets: strings,
					optional: trueKey,
					label: optionalString,
					inverse: optionalString
				})
			)
		),
		many: Schema.optionalKey(strings),
		children: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct(childIdentity))),
		masked: Schema.optionalKey(strings),
		create: Schema.optionalKey(
			Schema.Struct({
				columns: strings,
				filled: Schema.optionalKey(strings),
				proposalOnly: trueKey,
				with: children
			})
		),
		update: Schema.optionalKey(Schema.Struct({ columns: strings, with: children })),
		readonlyFields: Schema.optionalKey(
			Schema.Record(Schema.String, Schema.Literals(['syncOwned', 'ownedParent']))
		),
		description: optionalString,
		delete: trueKey,
		syncs: Schema.optionalKey(Schema.Record(Schema.String, SyncExposureSchema))
	})
);

/** The entire public hydration boot: no authority, internal navigation, credentials, agent or Studio data. */
export const PublicBoot = Schema.Struct({
	workspace: Schema.Struct({
		name: Schema.String,
		locale: Schema.String,
		tz: Schema.String,
		logo: optionalString,
		handle: optionalString,
		currency: optionalString
	}),
	actor: Schema.Json,
	base: Schema.String,
	visitor: Schema.NullOr(Schema.Struct({ app: Schema.String, siteKey: optionalString })),
	kiosk: Schema.NullOr(Schema.String),
	contract: Schema.String,
	describe: Schema.Boolean,
	messages: Schema.Record(Schema.String, Schema.String),
	catalog: PublicCatalog,
	automations: Schema.Record(
		Schema.String,
		Schema.Struct({ input: fields(), description: optionalString })
	)
});
export interface PublicBoot extends Schema.Schema.Type<typeof PublicBoot> {}

/** The same validated envelope is written by SSR and read before browser hydration. */
export const PublicHydration = Schema.Struct({
	route: Schema.String,
	release: Schema.String,
	locale: Schema.String,
	boot: PublicBoot,
	data: Schema.Json
});
export interface PublicHydration extends Schema.Schema.Type<typeof PublicHydration> {}

export const PUBLIC_HYDRATION_ID = 'bolt-public-hydration';

/** Project the admitted caller's boot; server-only or unrelated shell fields never cross this boundary. */
export const toPublicBoot = (
	boot: ShellBoot,
	options: {
		readonly base: string;
		readonly kiosk: string | null;
		readonly messages?: Readonly<Record<string, string>>;
		readonly describe?: boolean;
		readonly currency?: string;
	}
) =>
	Schema.decodeUnknownEffect(PublicBoot)({
		workspace: {
			name: boot.workspace.name,
			locale: boot.workspace.locale,
			tz: boot.workspace.tz,
			...(boot.workspace.logo === undefined ? {} : { logo: boot.workspace.logo }),
			...(boot.workspace.handle === undefined ? {} : { handle: boot.workspace.handle }),
			...(options.currency === undefined ? {} : { currency: options.currency })
		},
		actor: boot.actor,
		base: options.base,
		visitor: boot.visitor,
		kiosk: options.kiosk,
		contract: boot.contract,
		describe: options.describe ?? (boot.visitor === null && boot.aiUnconfigured !== true),
		messages: options.messages ?? {},
		catalog: boot.catalog,
		automations: boot.automations
	});

export class PublicHydrationFailure extends Schema.TaggedError<PublicHydrationFailure>()(
	'PublicHydrationFailure',
	{
		reason: Schema.String
	}
) {}

/** Route, release and locale must agree before any data or tenant component reaches hydration. */
export const decodePublicHydration = <D>(
	text: string,
	codec: Schema.Codec<D, Json>,
	expected: { readonly route: string; readonly release: string }
) =>
	Effect.gen(function* () {
		const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PublicHydration))(
			text
		);
		if (
			envelope.route !== expected.route ||
			envelope.release !== expected.release ||
			envelope.locale !== envelope.boot.workspace.locale
		)
			return yield* new PublicHydrationFailure({
				reason: 'Public page route, release or locale changed before hydration.'
			});
		const data = yield* Schema.decodeUnknownEffect(codec)(envelope.data);
		return { data, boot: envelope.boot };
	});
