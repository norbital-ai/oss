// Answers a host decodes: the release's descriptor header, what the release says about itself, and the identity
// answers it acts on. Each is decoded with this package's Schemas, never with the host's own Bolt.
import { Schema } from 'effect';
import { StudioManifest } from './studio.ts';

/** The header of a release's `artifact.json` a host reads before any cell runs; the release's `verify` checks the rest. */
export const ArtifactHeader = Schema.Struct({
	/** The engine contract the release was built against: the pinned Bolt's `HostApi.contract`. */
	contract: Schema.String,
	/** The tenant handle (`norbital.template.json` `key`) and the display name. */
	handle: Schema.String,
	name: Schema.String,
	/** The schema fingerprint the release's migrations record. */
	schema: Schema.String,
	/** The release digest: its descriptor and every tree it carries. */
	hash: Schema.String
});
export type ArtifactHeader = typeof ArtifactHeader.Type;

/** `describe`: what a release says about itself, decoded by its own Bolt from its manifest. */
export const ReleaseFacts = Schema.Struct({
	/** The workspace's IANA time zone. */
	zone: Schema.String,
	/** The skill names the release ships for its agent. */
	skills: Schema.Array(Schema.String),
	/** Every declared page's address (`/app/<app>[/<page>]`). */
	pages: Schema.Array(Schema.String),
	/** Whether activation needs the environment's secrets store, and why the release cannot activate as built. */
	secrets: Schema.Boolean,
	issues: Schema.Array(Schema.String),
	/** The declarations Studio lists. */
	studio: StudioManifest
});
export type ReleaseFacts = typeof ReleaseFacts.Type;

/** `session.mint` (the apex handoff): the host sets `cookies.session` to `token` until `expires_at`. */
export const MintedSession = Schema.Struct({
	token: Schema.String,
	user: Schema.String,
	expires_at: Schema.String
});
export type MintedSession = typeof MintedSession.Type;
/** `founder.bootstrap`: the first administrator, or the identity refusal (`forbidden`: one exists already). */
export const FounderAnswer = Schema.Union([
	Schema.TaggedStruct('Founded', { user: Schema.String }),
	Schema.TaggedStruct('FounderRefused', { code: Schema.String, message: Schema.String })
]);
export type FounderAnswer = typeof FounderAnswer.Type;
