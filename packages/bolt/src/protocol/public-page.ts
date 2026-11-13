import { Effect, Schema } from 'effect';
import { KindSchema } from '@norbital-ai/store/kind';
import type { WireRead } from './wire.ts';
import type { ShellBoot } from '../shell/nav.ts';
import { ReadCatalog } from './read-answer.ts';
import { EngineActorSchema } from './schema.ts';
import { OperationOutputs } from './output-contract.ts';

const optionalString = Schema.optionalKey(Schema.String);
const strings = Schema.Array(Schema.String);
const trueKey = Schema.optionalKey(Schema.Literal(true));
const predicate = Schema.Record(Schema.String, Schema.Json);
const kind = KindSchema;
const fields = () => Schema.Record(Schema.String, kind);
/** Metadata codecs are shared by browser-catalog emission and public hydration. */
export const FieldsSchema = fields();
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
		Schema.Struct({ columns: strings, filled: Schema.optionalKey(strings), proposal_only: trueKey })
	),
	update: Schema.optionalKey(Schema.Struct({ columns: strings })),
	delete: trueKey,
	link: trueKey,
	unlink: trueKey
});
const children = Schema.optionalKey(Schema.Record(Schema.String, child));

const relation = {
	targets: strings,
	optional: trueKey,
	label: optionalString,
	inverse: optionalString
};
/** A model's presentation metadata both catalogs share. */
const exposure = {
	label: strings,
	record_label: optionalString,
	label_paths: Schema.optionalKey(strings),
	search: Schema.optionalKey(strings),
	semantic: trueKey,
	audit: Schema.optionalKey(Schema.Literal(false)),
	indexes: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Struct({ input: fields(), description: Schema.String }))
	),
	fields: fields(),
	relations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct(relation))),
	many: Schema.optionalKey(strings),
	children: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct(childIdentity))),
	/** The named read output the caller's views read this model as (absent: `default`). */
	output: Schema.optionalKey(Schema.String),
	create: Schema.optionalKey(
		Schema.Struct({
			columns: strings,
			filled: Schema.optionalKey(strings),
			proposal_only: trueKey,
			with: children
		})
	),
	update: Schema.optionalKey(Schema.Struct({ columns: strings, with: children })),
	readonly_fields: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Literals(['sync_owned', 'owned_parent']))
	),
	description: optionalString,
	delete: trueKey,
	syncs: Schema.optionalKey(Schema.Record(Schema.String, SyncExposureSchema))
};
/** Caller-filtered presentation metadata, decoded without trusting a manifest or arbitrary object cast. */
const PublicCatalog = Schema.Record(Schema.String, Schema.Struct(exposure));
/** One model as the signed-in shell's catalog exposes it to its caller (ui's `ModelExposure`): a relation's static
 * `where`, the read layers and the own-field lock as well. */
export const ModelExposureSchema = Schema.Struct({
	...exposure,
	relations: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({ ...relation, where: Schema.optionalKey(predicate) })
		)
	),
	layers: Schema.optionalKey(strings),
	locks: Schema.optionalKey(Schema.Array(Schema.Struct({ where: predicate, except: Schema.optionalKey(strings) })))
});
/** A declared automation the caller may start (ui's `AutomationExposure`). */
export const AutomationExposureSchema = Schema.Struct({
	input: fields(),
	mode: Schema.optionalKey(Schema.Literals(['job', 'call'])),
	description: optionalString
});

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
	actor: Schema.NullOr(EngineActorSchema),
	location: Schema.Struct({ pathname: Schema.String, search: Schema.String }),
	base: Schema.String,
	visitor: Schema.NullOr(Schema.Struct({ app: Schema.String, site_key: optionalString })),
	kiosk: Schema.NullOr(Schema.String),
	contract: Schema.String,
	describe: Schema.Boolean,
	messages: Schema.Record(Schema.String, Schema.String),
	catalog: PublicCatalog,
	read_catalog: ReadCatalog,
	automations: Schema.Record(Schema.String, AutomationExposureSchema),
	operation_outputs: OperationOutputs
});
export interface PublicBoot extends Schema.Schema.Type<typeof PublicBoot> {}

/** A page query and its first streamed registration use the same request key. */
export const public_read_key = (read: WireRead) => JSON.stringify(read);
export const PublicReads = Schema.Record(Schema.String, Schema.Json);
export type PublicReads = typeof PublicReads.Type;

/** The request-scoped boot and initial reads shared by SSR and browser hydration. */
export const PublicHydration = Schema.Struct({
	route: Schema.String,
	release: Schema.String,
	locale: Schema.String,
	boot: PublicBoot,
	reads: PublicReads
});
export interface PublicHydration extends Schema.Schema.Type<typeof PublicHydration> {}

export const PUBLIC_HYDRATION_ID = 'bolt-public-hydration';

/** Project the admitted caller's boot; server-only or unrelated shell fields never cross this boundary. */
export const toPublicBoot = (
	boot: ShellBoot,
	options: {
		readonly base: string;
		readonly location: PublicBoot['location'];
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
		location: options.location,
		base: options.base,
		visitor: boot.visitor,
		kiosk: options.kiosk,
		contract: boot.contract,
		describe: options.describe ?? (boot.visitor === null && boot.ai_unconfigured !== true),
		messages: options.messages ?? {},
		catalog: boot.catalog,
		read_catalog: boot.read_catalog,
		automations: boot.automations,
		operation_outputs: boot.operation_outputs
	});

export class PublicHydrationFailure extends Schema.TaggedError<PublicHydrationFailure>()(
	'PublicHydrationFailure',
	{
		reason: Schema.String
	}
) {}

/** Route, release and locale must agree before hydration. */
export const decodePublicHydration = (
	text: string,
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
		return { reads: envelope.reads, boot: envelope.boot };
	});
