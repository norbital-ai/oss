// The browsing facility the agent's `browser_*` tools drive: the host's headless browser, one profile per person or run.
import { Schema } from 'effect';
import type { Actor, AgentMark } from './authority.ts';
import type { Downloaded } from './facilities.ts';
import type { Json } from '@norbital-ai/store';

/** An automation run's browser profile: this prefix and the run id. The host discards it when the run's session ends. */
export const BROWSER_RUN_PROFILE = '\u0001run:';
/** A person's browser profile for one conversation: one identity per person, a session (tab) per conversation. */
export const person_browser_profile = (person: string, conversation: string): string =>
	`person:${person}\u0000${conversation}`;

/** The readable page and its control refs, with host-provided page metadata retained. */
export const BrowserSnapshotSchema = Schema.StructWithRest(
	Schema.Struct({ url: Schema.String, title: Schema.NullOr(Schema.String), text: Schema.String }),
	[Schema.Record(Schema.String, Schema.Json)]
);
/** The readable page and its control refs (`BrowserSnapshotSchema`). */
export type BrowserSnapshot = typeof BrowserSnapshotSchema.Type;

/** One action on a ref from the current snapshot. */
export const BrowserStepSchema = Schema.Union([
	Schema.Struct({ click: Schema.String }),
	Schema.Struct({ type: Schema.Struct({ ref: Schema.String, text: Schema.String, submit: Schema.optionalKey(Schema.Boolean) }) }),
	Schema.Struct({ select: Schema.Struct({ ref: Schema.String, value: Schema.String }) }),
	Schema.Struct({ press: Schema.String }),
	Schema.Struct({ hover: Schema.String }),
	Schema.Struct({ scroll: Schema.Struct({ ref: Schema.optionalKey(Schema.String), y: Schema.optionalKey(Schema.Finite) }) }),
	Schema.Struct({ wait: Schema.Struct({ text: Schema.optionalKey(Schema.String), ms: Schema.optionalKey(Schema.Finite) }) })
]);
/** One action on a ref from the current snapshot (`BrowserStepSchema`). */
export type BrowserStep = typeof BrowserStepSchema.Type;

/** Where the agent's browser goes: a page, or back, forward or a reload of the one open. */
export type BrowserTarget =
	{ readonly url: string } | { readonly go: 'back' | 'forward' | 'reload' };
/** The page's own CSS size and pixel density: what the person's browser would lay out at. */
export type BrowserViewport = {
	width: number;
	height: number;
	device_scale_factor?: number;
};
/** A workspace page the agent's browser opens: `live`, or a preview environment by its name. */
export type BrowserWorkspaceTarget = {
	readonly environment: string;
	readonly path?: string;
	readonly device?: 'desktop' | 'tablet' | 'phone';
};
/** Who a workspace page is opened for: the person, the conversation, and the agent's mark when it has one. */
export type BrowserCaller = {
	readonly actor: Actor;
	readonly conversation: string;
	readonly agent?: AgentMark;
};
/**
 * The browsing facility the built-in `browser_*` tools drive. Each `profile` is one browser of its own, its sign-ins and
 * site data kept between calls: a person's id, or the release's run profile prefix + `<run id>:<inference id>` for one
 * inference of a run. Pages answer as text with a ref on every control; a PDF answers its extracted text, page by page.
 */
export interface BrowserPort {
	/** Open the profile's isolated tab. A failed open is an error, and close must release any partial resources. */
	open(profile: string, signal: AbortSignal): Promise<void>;
	navigate(
		profile: string,
		to: BrowserTarget,
		find: string | undefined,
		signal: AbortSignal,
		viewport?: BrowserViewport
	): Promise<BrowserSnapshot>;
	/**
	 * Open a page of the workspace as the person, signed in by the host's hand-off: the internal half of `browser`.
	 * A host that cannot sign its browser in omits it, and the agent is not offered workspace pages.
	 */
	open_workspace?(
		profile: string,
		target: BrowserWorkspaceTarget,
		caller: BrowserCaller,
		signal: AbortSignal
	): Promise<BrowserSnapshot>;
	/** Close this profile's tab and release its page resources; its sealed sign-ins stay for the next open. */
	close(profile: string, signal: AbortSignal): Promise<void>;
	snapshot(
		profile: string,
		options: { find?: string; from?: number },
		signal: AbortSignal
	): Promise<BrowserSnapshot>;
	act(profile: string, steps: readonly BrowserStep[], signal: AbortSignal): Promise<BrowserSnapshot>;
	evaluate(profile: string, expression: string, signal: AbortSignal): Promise<Json>;
	screenshot(profile: string, signal: AbortSignal): Promise<Uint8Array>;
	/**
	 * A media file at `url` fetched in the profile's session (its sign-ins) and stored as `FilesPort.download` stores one:
	 * classified by its first bytes, streamed into the store, never held whole.
	 */
	download(profile: string, url: string, signal: AbortSignal): Promise<Downloaded>;
}
