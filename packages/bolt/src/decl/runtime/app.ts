// The workspace and its navigation (§3.3.1, X-19): `workspace()`, `app()` with its page files, `group()`.
// An app or group literal is typed against its own folder's children, so, like `collection`, it takes its name (the
// folder path); the build checks the name against the folder.
import type { Checked, Exact } from '../fields.ts';
import type { AppName, CollectionName, PolicyName } from '../names.ts';
import type { CurrencyCode, IanaZone, IconName, Msg, NonEmpty } from '../values.ts';
import type { AiModelClass, ChildName, GroupName, PageName } from './names.ts';
import type { ConvertTarget } from './facilities.ts';

type EnvDecl = { label: string; description?: string; secret?: boolean; default?: string };
// secret unless `secret: false`; only a non-secret carries a default
type EnvFor<D> = D extends { default: unknown } ? D extends { secret: false } ? EnvDecl
	: { label: string; description?: string; secret?: boolean; default: 'error: only a non-secret (secret: false) takes a default' } : EnvDecl;
type WorkspaceBase = {
	/** The workspace's IANA zone: `today`, date defaults and document numbers are read in it. */
	tz: IanaZone;
	/** The default locale tag. */
	locale: string;
	/** The default currency of money fields that name none. */
	currency?: CurrencyCode;
	/** App order in the launcher. */
	apps?: readonly string[];
	/** The environment names (UPPER_SNAKE) connections and MCP servers read; secret unless `secret: false`. */
	env?: { readonly [name: string]: EnvDecl };
	/** The model classes agents may use, the default one, and the embedding models. */
	ai?: { models: readonly AiModelClass[]; default: AiModelClass; embeddings?: readonly string[] };
	/** The document formats automations convert Markdown or HTML to (`ctx.convert.document`); the host must serve each. */
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
 * an external member holding `policies`. `party` names the record that is them — the row of `collection` whose
 * `match[email | phone]` field holds the proven address — so a guest already on file (a customer who booked without an
 * account) is promoted to a registered member bound to their own rows (`{ actor: 'party' }`). An administrator can close
 * sign-up in Settings without a release.
 */
type Signup = {
	via: NonEmpty<'email' | 'phone'>;
	policies: NonEmpty<string>;
	party?: { collection: string; match: { email?: string; phone?: string } };
};
type SignupFor = {
	via: NonEmpty<'email' | 'phone'>;
	policies: NonEmpty<PolicyName>;
	party?: { collection: CollectionName; match: { email?: string; phone?: string } };
};
type WorkspaceFor<S> = {
	tz: IanaZone; locale: string; currency?: CurrencyCode;
	/** App order in the launcher. */
	apps?: readonly AppName[];
	/** Secret by default; a non-secret may carry a default (`GOOGLE_CALENDAR_BASE_URL`). */
	env?: { [N in keyof Part<S, 'env'>]: N extends Uppercase<N & string> ? EnvFor<Part<S, 'env'>[N]> : 'error: env names are UPPER_SNAKE' };
	ai?: { models: readonly AiModelClass[]; default: Part<Part<S, 'ai'>, 'models'> extends readonly (infer M)[] ? M : AiModelClass;
		embeddings?: readonly string[] };
	/** The document formats `ctx.convert.document` produces; each is a type-checked target with its own options. */
	convert?: { to: readonly ConvertTarget[] };
	/** Origins pages may fetch (model weights); scripts stay same-origin. */
	csp?: { connect?: readonly `https://${string}`[] };
	/** Rule 60a (hook:triage): the in-app agent is triaged where the host binds the port; `false` opts out. */
	agent?: { triage?: false };
	/** Self sign-up by a proven email or mobile number; the build checks `party.match` names text fields. */
	signup?: SignupFor;
};
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};

/**
 * `src/+workspace.ts`, exactly one: the workspace's timezone and locale, the app order in the nav, the `env` names its
 * connections and MCP servers read, and AI settings.
 * @example
 * export default workspace({ tz: 'Asia/Singapore', locale: 'en-SG', apps: ['crm'] });
 */
export function workspace<const S extends WorkspaceBase>(spec: S & Checked<WorkspaceBase, S, Exact<S, WorkspaceFor<S>>>): S {
	return spec;
}

type Audience = 'members' | 'external' | 'all' | { public: NonEmpty<string>; challenge?: 'turnstile' };
/**
 * `site`: the page renders alone — no sidebar, banner, tabs or agent — and another website may embed it in a frame. A
 * device kiosk in a members app, or a customer-facing page in an external or public app; the app's audience decides who
 * opens it. Sites are listed under the account menu's Sites, never as sidebar rows or tabs.
 */
type Page = { title: Msg; icon?: IconName; section?: Msg; site?: true };
type AppBase = {
	title: Msg; description: Msg; icon: IconName;
	/** The app card image, an asset path. */
	banner?: string;
	/** Who sees the app: `members` (default), `external`, `all`, or `{ public }` for signed-out visitors. */
	audience?: Audience;
	/** The app's pages by file name, in nav order: a title, icon and optional section each. */
	pages: { readonly [page: string]: Page };
};
type AppFor<A> = {
	title: Msg; description: Msg; icon: IconName;
	/** The app card image, an asset path. */
	banner?: string;
	/** Default 'members'; `{ public }` pages run as the signed-out visitor (§3.9). */
	audience?: 'members' | 'external' | 'all' | { public: NonEmpty<PolicyName>; challenge?: 'turnstile' };
	/** Key order is nav order; every page file needs an entry (build `app/page-unlisted`). */
	pages: { [P in PageName<A>]?: Page };
};

/**
 * `src/app/<a>/+app.ts`: an app's title, description, icon and banner, its `audience`, and its pages in nav order (each
 * `+<page>.page.svelte` in the folder needs an entry).
 * @example
 * export default app('crm', {
 * 	title: 'app.crm.title',
 * 	description: 'app.crm.description',
 * 	icon: 'lucide:handshake',
 * 	pages: { desk: { title: 'app.crm.title', icon: 'lucide:handshake' } }
 * });
 */
export function app<const A extends AppName, const S extends AppBase>(name: A, spec: S & Checked<AppBase, S, Exact<S, AppFor<A>>>): { readonly name: A; readonly spec: S } {
	return { name, spec };
}

type GroupBase = { label: Msg; description?: Msg; icon: IconName; defaultChild: string };
/**
 * `src/app/<g>/+group.ts`: a folder of apps shown as one entry in the nav, opening `defaultChild`; a policy's
 * `capabilities.apps` naming the group reaches every app under it.
 * @example
 * export default group('hr', { label: 'HR', icon: 'lucide:briefcase-business', defaultChild: 'people' });
 */
export function group<const G extends GroupName, const S extends GroupBase>(name: G,
	spec: S & Checked<GroupBase, S, Exact<S, { label: Msg; description?: Msg; icon: IconName; defaultChild: ChildName<G> }>>): { readonly name: G; readonly spec: S } {
	return { name, spec };
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
