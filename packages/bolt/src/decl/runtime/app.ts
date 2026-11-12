// The workspace and its navigation (§3.3.1, X-19): `workspace()`, `app()` with its page files, `group()`.
// The path supplies an app or group's name and the compiler checks its child declarations.
import { Schema } from 'effect';
import type { Checked, Exact } from '../fields.ts';
import type { AppName, ModelName, PolicyName } from '../names.ts';
import type { CurrencyCode, IanaZone, IconName, Msg, NonEmpty } from '../values.ts';
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
	/** Requires AI facilities and declares embedding models; administrators choose allowed chat models at runtime. */
	ai?: { embeddings?: readonly string[] };
	/**
	 * The document formats Markdown or HTML converts to (`ctx.convert.document`, notice attachments, a
	 * file sync's document export); the host must serve each.
	 */
	convert?: { to: readonly ConvertTarget[] };
	/** Origins pages may connect to beyond the workspace. */
	csp?: { connect?: readonly `https://${string}`[] };
	/** `triage: false` turns off System 1 triage of the in-app agent. */
	agent?: { triage?: false }; // hook:triage
	/** Who may join without an invitation (§5.11.2); absent, only invited members join. */
	signup?: Signup;
};
/**
 * Self sign-up: a newcomer proves an address (`via`: a code by email, by SMS to a mobile number, or either) and becomes
 * an external member holding `policies`. `party` names the record that is them — the row of `model` whose
 * `match[email | phone]` field holds the proven address — so a guest already on file (a customer who booked without an
 * account) is promoted to a registered member bound to their own rows (`{ var: 'requestor.party' }`). An administrator can close
 * sign-up in Settings without a release.
 */
type Signup = {
	via: NonEmpty<'email' | 'phone'>;
	policies: NonEmpty<string>;
	party?: { model: string; match: { email?: string; phone?: string } };
	/** A stranger's code is paid for: the page they join on must pass this first. Members sign in without it. */
	challenge?: 'turnstile';
};
type SignupFor = {
	via: NonEmpty<'email' | 'phone'>;
	policies: NonEmpty<PolicyName>;
	party?: { model: ModelName; match: { email?: string; phone?: string } };
	challenge?: 'turnstile';
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

};

/**
 * `src/+workspace.ts`, exactly one: timezone, locale, app order and workspace capabilities.
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
	challenge: Schema.optionalKey(Schema.Literal('turnstile'))
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
type PublicAudience<P extends string> = { public: NonEmpty<P>; challenge?: 'turnstile' };
type AppAccess<P extends string> =
	| { shell?: never; audience?: SignedInAudience | PublicAudience<P>; policies?: never }
	| { shell: 'kiosk'; audience?: SignedInAudience; policies: NonEmpty<P> }
	| { shell: 'kiosk'; audience: PublicAudience<P>; policies?: never };

/** Device permissions that must be granted before an app's pages open. */
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
 * `+<page>.page.svelte` in the folder needs an entry).
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
