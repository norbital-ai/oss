// The workspace and its navigation (X-19): `workspace()`, `app()` with its page files, `group()`.
// The path supplies an app or group's name and the compiler checks its child declarations.
import { Schema } from 'effect';
import type { Checked, Exact } from '../fields.ts';
import type { AppName, ModelName, PolicyName } from '../names.ts';
import type { CurrencyCode, IanaZone, IconName, NonEmpty, Rate } from '../values.ts';
import type { ChildName, GroupName, PageName } from './names.ts';
import type { ConvertTarget } from './facilities.ts';

/** One secret: the label and help Settings shows; its value is supplied at runtime and sealed in the tenant store. */
type SecretDecl = { label: string; description?: string };
/**
 * Declares secret names and their Settings labels in `src/+secrets.ts`. This is metadata, never a place for values.
 * Administrators supply values at runtime; the host seals them in the tenant store. Refer to a declared name when
 * configuring an integration or MCP connection rather than copying its value into source or browser code. Once the
 * declaration is live, `page { configure: { capability: 'secret.set', record: '<NAME>' } }` in a web conversation opens the native
 * write-only form; the value is never read back or sent through chat.
 * @param spec UPPER_SNAKE names with labels and optional help text.
 * @returns The declaration unchanged; declaring a name neither supplies nor verifies its runtime value.
 * @example
 * export default secrets({ SERVICE_TOKEN: { label: 'Service token', description: 'Pair in Settings.' } });
 */
export function secrets<const E extends Record<string, SecretDecl>>(
	spec: E &
		Exact<
			E,
			{
				[N in keyof E]: N extends Uppercase<N & string>
					? SecretDecl
					: 'error: secret names are UPPER_SNAKE';
			}
		>
): E {
	return spec;
}
type WorkspaceBase = {
	/** The workspace's IANA zone: `today`, date defaults and document numbers are read in it. */
	tz: IanaZone;
	/** The default locale tag. */
	locale: string;
	/** The default currency of money fields that name none. */
	currency?: CurrencyCode;
	/** App order in the launcher. */
	apps?: readonly string[];
	/**
	 * Requires AI facilities and declares embedding models. Allowed chat models and monthly USD caps (workspace, default
	 * member, per policy) are runtime settings in `sys_config` under `agent`, applied at the next step; an empty allowed
	 * list permits the host catalogue, else its first model is the fallback. `limits.<policy>.agent` still limits rate.
	 */
	ai?: { embeddings?: readonly string[] };
	/**
	 * The document formats Markdown or HTML converts to (`ctx.convert.document`, notice attachments, a
	 * file sync's document export); the host must serve each. A declared target the host does not serve is a check
	 * warning and fails `Unavailable` when used.
	 */
	convert?: { to: readonly ConvertTarget[] };
	/** Origins pages may connect to beyond the workspace. */
	csp?: { connect?: readonly `https://${string}`[] };
	/** `triage: false` turns off System 1 triage of the in-app agent. */
	agent?: { triage?: false }; // hook:triage
	/** Who may join without an invitation; absent, only invited members join. */
	signup?: Signup;
	/** Rate limits per policy, applied to every caller holding it. */
	limits?: { readonly [policy: string]: { readonly [key: string]: unknown } };
};
/**
 * Self sign-up: a newcomer proves an address (`via`: a code by email, by SMS to a mobile number, or either) and becomes
 * an external member holding `policies`. `party` names the record that is them — the row of `model` whose
 * `match[email | phone]` field holds the proven address — so a guest already on file (a customer who booked without an
 * account) is promoted to a registered member bound to their own rows (`{ var: 'actor.party' }`). An administrator can close
 * sign-up in Settings without a release.
 *
 * Sign-in codes go only to active members, open invitations and newcomers this admits; any other address is
 * `not_member` before a code is sent. Sign-up texts are capped at 50 an hour per workspace and 10 per address.
 */
type Signup = {
	via: NonEmpty<'email' | 'phone'>;
	policies: NonEmpty<string>;
	/**
	 * The link to the party record lasts only while that record holds the proven address, rechecked on every request:
	 * when the address changes or the record goes, the old holder sees nothing and the new holder takes it. A party
	 * named on an invitation is never rechecked.
	 */
	party?: { model: string; match: { email?: string; phone?: string } };
	/**
	 * A stranger's code is paid for: the public page or kiosk they join on must pass this bot check first. Members sign
	 * in without it. The workspace's own sign-in page has no widget, so it stops offering sign-up; a host with no
	 * `challenge` facility refuses strangers, except a local one. The host's facility chooses the provider.
	 */
	challenge?: true;
};
type SignupFor = {
	via: NonEmpty<'email' | 'phone'>;
	policies: NonEmpty<PolicyName>;
	party?: { model: ModelName; match: { email?: string; phone?: string } };
	challenge?: true;
};
type WorkspaceFor = {
	tz: IanaZone;
	locale: string;
	currency?: CurrencyCode;
	/** App order in the launcher. */
	apps?: readonly AppName[];
	ai?: { embeddings?: readonly string[] };
	/** The document formats the converter produces; each is a type-checked target with its own options. */
	convert?: { to: readonly ConvertTarget[] };
	/** Origins pages may fetch (model weights); scripts stay same-origin. */
	csp?: { connect?: readonly `https://${string}`[] };
	/** Rule 60a (hook:triage): the in-app agent is triaged where the host binds the port; `false` opts out. */
	agent?: { triage?: false };
	/** Self sign-up by a proven email or mobile number; the build checks `party.match` names text fields. */
	signup?: SignupFor;
	/**
	 * Rate limits per policy: what a caller holding that policy may send. Undeclared keys take the defaults (`LimitKey`).
	 * @example limits: { field_ops_contractor: { act: '600/min', read: '600/min', agent: '100/h' } }
	 */
	limits?: { [P in PolicyName]?: { [K in LimitKey]?: K extends EnvoyKey ? EnvoyLimit : Limit } };
};

/** A rate limit: `'<n>/<unit>'`, optionally `per` actor or IP; a list applies every rule. */
export type Limit =
	Rate | { rate: Rate; per: 'actor' | 'ip' } | readonly { rate: Rate; per: 'actor' | 'ip' }[];
/** A rate limit on an envoy's inbound traffic, counted `per` sender or per subject. */
type EnvoyLimit =
	| Rate
	| { rate: Rate; per: 'sender' | 'subject' }
	| readonly { rate: Rate; per: 'sender' | 'subject' }[];
type EnvoyKey = 'envoys.receive' | 'envoys.unrecognised';
/**
 * What a `limits` entry throttles: acts, reads, agent turns, registration, uploads, page PDF previews
 * (`convert`, `ctx.preview_pdf`; default `30/min`) or envoy traffic. Requests only: automation bodies are never limited,
 * and manual starts have a separate fixed quota per automation and starter (30 a minute).
 *
 * Undeclared keys take defaults: members `act 600/min`, `read 3000/min`, `upload 120/min`, `convert 30/min`,
 * `agent 100/h`, `envoys.unrecognised 1/15min` per sender; visitors, per IP: `act 120/h`, `read 600/min`, `upload 20/h`,
 * `register 20/h`. Windows are fixed and counted in the serving cell's memory (acts also persist theirs). A refusal is
 * `429` with `Retry-After` and `{ code: 'rate_limited' }`.
 */
export type LimitKey = 'act' | 'read' | 'agent' | 'register' | 'upload' | 'convert' | EnvoyKey;

/**
 * `src/+workspace.ts`, exactly one: timezone, locale, app order, workspace capabilities and rate limits per policy.
 * Declarations are found by path and named by it; each takes one literal (`model` and `integration` first repeat
 * their name, which must match the path), and every callback sits inside the declaration that invokes it. `bolt sync`
 * (run by `bolt dev` on save and first by `bolt check`) writes their data shapes into the generated, never-edited
 * `.norbital/`.
 * ```text
 * src/+workspace.ts, +secrets.ts
 * src/data/model/<name>/+model.ts, +representation.svelte    (folders may nest; the leaf names the model)
 * src/data/custom_field/<name>/+custom_field.ts, +renderer.svelte
 * src/access_control/team/+team.ts, policy/+<name>.policy.ts
 * src/integration/<name>/+integration.ts, +integration.svelte
 * src/automation/+<name>.automation.ts
 * src/agent/+agent.md, +agent.external.md, skill/<name>/+skill.md, mcp/+<name>.mcp.ts
 * src/app/, src/i18n/+messages.ts, src/lib/ (ordinary helpers)
 * seed/ (public/ ships in the release, test/ serves bolt test, +seeder.ts)
 * migrations/ (generated, editable SQL and its proofs), tests/
 * ```
 * @param spec Workspace settings; integration accounts and credentials are created at runtime.
 * @returns The typed declaration unchanged. Compilation validates its references against this workspace's names.
 * @example
 * export default workspace({ tz: 'Asia/Singapore', locale: 'en-SG', apps: ['crm'] });
 */
export function workspace<const S extends WorkspaceBase>(
	spec: S & Checked<WorkspaceBase, S, Exact<S, WorkspaceFor>>
): S {
	return spec;
}

const appContent = {
	title: Schema.String,
	description: Schema.String,
	icon: Schema.String,
	banner: Schema.optionalKey(Schema.String),
	/**
	 * Origins allowed to frame the app's pages; by default only the workspace itself. Framing grants no data authority:
	 * embedded sessions use `SameSite=None; Secure; Partitioned` cookies, one session per embedding site.
	 */
	embed: Schema.optionalKey(Schema.Array(Schema.TemplateLiteral(['https://', Schema.String]))),
	requires: Schema.optionalKey(
		Schema.Array(Schema.Literals(['location', 'location:background', 'notifications', 'camera']))
	),
	pages: Schema.Record(
		Schema.String,
		Schema.Struct({
			title: Schema.String,
			icon: Schema.optionalKey(Schema.String),
			section: Schema.optionalKey(Schema.String),
			portal: Schema.optionalKey(Schema.Literal(true))
		})
	)
};
const SignedInAudience = Schema.Literals(['members', 'external', 'all']);
const AppPolicies = Schema.NonEmptyArray(Schema.String);
const PublicAudience = Schema.Struct({
	public: AppPolicies,
	challenge: Schema.optionalKey(Schema.Literal(true))
});
export const AppData = Schema.Union([
	Schema.Struct({
		...appContent,
		shell: Schema.optionalKey(Schema.Never),
		policies: Schema.optionalKey(Schema.Never),
		audience: Schema.optionalKey(Schema.Union([SignedInAudience, PublicAudience]))
	}),
	Schema.Struct({
		...appContent,
		shell: Schema.Literal('kiosk'),
		policies: AppPolicies,
		audience: Schema.optionalKey(SignedInAudience)
	}),
	Schema.Struct({
		...appContent,
		shell: Schema.Literal('kiosk'),
		policies: Schema.optionalKey(Schema.Never),
		audience: PublicAudience
	})
]);

type SignedInAudience = typeof SignedInAudience.Type;
/** `challenge: true`: each request that needs one passes the host's bot check (its `challenge` facility). */
type PublicAudience<P extends string> = { public: NonEmpty<P>; challenge?: true };
type AppAccess<P extends string> =
	| {
			shell?: never;
			/**
			 * Who opens the app: `members` (default) through the workspace SPA; `external`, `all` or `{ public }` are
			 * server-rendered per page and hydrated, and a signed-out request for a sign-in page answers `303` to
			 * `/sign-in?next=<path>`. `{ public: policies }` serves anyone, minting an anonymous visitor (`sys_user` kind
			 * `anonymous`, a 30-day sliding session) whose `actor.id` owns what it creates; signing in links it to the
			 * account.
			 */
			audience?: SignedInAudience | PublicAudience<P>;
			policies?: never;
	  }
	| {
			/** Serves the pages at `/kiosk/<app>/<page>` under fixed policies. */
			shell: 'kiosk';
			audience?: SignedInAudience;
			/** A signed-in kiosk caller's entire authority on its pages. Capabilities are refused for `external`. */
			policies: NonEmpty<P>;
	  }
	| { shell: 'kiosk'; audience: PublicAudience<P>; policies?: never };

/**
 * Device permissions (`location`, `location:background`, `notifications`, `camera`) an app's `requires` holds its pages
 * behind until the member grants them.
 */
export type DeviceRequirement = NonNullable<AppSpec['requires']>[number];
/** An app's pages and audience. The kiosk shell runs under its assigned policies. */
export type AppSpec = typeof AppData.Type;
type AppContent = Omit<AppSpec, keyof AppAccess<string>>;
type Page = AppSpec['pages'][string];
type AppFor = Omit<AppContent, 'pages'> &
	AppAccess<PolicyName> & {
		/** Key order is nav order; every page file needs an entry (build `app/page-unlisted`). */
		pages: { [P in PageName<AppName>]?: Page };
	};

/**
 * `src/app/<a>/+app.ts`: an app's title, description, icon and banner, its `audience`, and its pages in nav order (each
 * `+<page>.page.svelte` in the folder needs an entry). An optional `+session.svelte` beside it mounts once for every
 * signed-in caller the app is granted to, receives `ctx` like a page, stays mounted across navigation and is disposed with
 * the signed-in client: run its device work (a position watch) with `{@attach attach(...)}` so disposal interrupts it.
 * It grants no server policy. A page's browser graph may not reach server declaration roles, `.env` files,
 * server-named files or `server/` directories (type-only imports are fine): share browser values through `src/lib/`.
 *
 * Kiosks: staff open them through `capabilities.apps`, administrators directly, external members those that admit
 * them. Public visitors: minting is limited per IP (`register`); past it a page opens with a per-request identity that
 * owns nothing. When a visitor signs in, a newcomer's account is the anonymous user; an existing account absorbs its
 * `sys_user` refs (except state-locked fields) and the anonymous user is deactivated. The daily prune deletes
 * anonymous users with no live session that no record references.
 * @example
 * export default app({
 * 	title: 'app.crm.title',
 * 	description: 'app.crm.description',
 * 	icon: 'lucide:handshake',
 * 	pages: { desk: { title: 'app.crm.title', icon: 'lucide:handshake' } }
 * });
 */
export function app<const S extends AppSpec>(
	spec: S & Checked<AppSpec, S, AppFor & Exact<S, AppFor>>
): S {
	return spec;
}

/** A group literal: its title, description, icon and the child it opens. */
export const GroupSpec = Schema.Struct({
	title: Schema.String, description: Schema.optionalKey(Schema.String),
	icon: Schema.String, default_child: Schema.String
});
export type GroupSpec = typeof GroupSpec.Type;
/**
 * `src/app/<g>/+group.ts`: a folder of apps shown as one entry in the nav, opening `default_child`.
 * A policy's `capabilities.apps` naming the group reaches every app under it.
 * @example
 * export default group({ title: 'HR', icon: 'lucide:briefcase-business', default_child: 'people' });
 */
export function group<const S extends GroupSpec>(
	spec: S &
		Checked<
			GroupSpec,
			S,
			Exact<S, Omit<GroupSpec, 'default_child'> & { default_child: ChildName<GroupName> }>
		>
): S {
	return spec;
}

/**
 * `src/i18n/+messages.ts` (the base catalogue) and `src/i18n/+<locale>.messages.ts`: message keys to text with `{name}`
 * placeholders. A locale's keys must be the base's (checked by `Verify`). Pages read them with `bolt.t`.
 * @example
 * export default messages({ 'app.crm.title': 'CRM', 'jobs.assigned': 'Assigned to {name}' });
 */
export function messages<const M extends { readonly [key: string]: string }>(spec: M): M {
	return spec;
}
