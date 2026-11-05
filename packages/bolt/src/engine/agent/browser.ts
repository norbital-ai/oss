// The built-in `browser_*` tools: Bolt's own, over the host's browsing facility (`Browser`). A host that supplies none
// still offers them; each call answers that the browser facility is missing.
import { Effect, Schema, type SchemaAST } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { EngineActor } from '../contracts.ts';
import { Browser } from '../ports.ts';
import type { AgentHostConfig } from './index.ts';
import { CLOSED, type HostTool, type HostToolContext, type StudioRole } from './tools.ts';

/** An automation run's browser profile: this prefix and the run id. The host discards it when the run's session ends. */
export const BROWSER_RUN_PROFILE = '\u0001run:';

const OptionalString = Schema.optionalKey(Schema.String),
	OptionalNumber = Schema.optionalKey(Schema.Finite);
const Type = Schema.Struct({
		ref: Schema.String,
		text: Schema.String,
		submit: Schema.optionalKey(Schema.Boolean)
	}),
	Select = Schema.Struct({ ref: Schema.String, value: Schema.String }),
	Scroll = Schema.Struct({ ref: OptionalString, y: OptionalNumber }),
	Wait = Schema.Struct({ text: OptionalString, ms: OptionalNumber });
const Step = Schema.Union([
	Schema.Struct({ click: Schema.String }),
	Schema.Struct({ type: Type }),
	Schema.Struct({ select: Select }),
	Schema.Struct({ press: Schema.String }),
	Schema.Struct({ hover: Schema.String }),
	Schema.Struct({ scroll: Scroll }),
	Schema.Struct({ wait: Wait })
]);
/** The same steps as the model is offered them: each sets one key; `Step` decodes it. */
const Offered = Schema.Struct({
	click: OptionalString,
	type: Schema.optionalKey(Type),
	select: Schema.optionalKey(Select),
	press: OptionalString,
	hover: OptionalString,
	scroll: Schema.optionalKey(Scroll),
	wait: Schema.optionalKey(Wait)
});
const Workspace = Schema.Struct({
	environment: Schema.String.annotate({ description: 'live or a preview name' }),
	path: Schema.optionalKey(
		Schema.String.check(
			Schema.makeFilter((path: string) => path.startsWith('/') && !path.startsWith('//'))
		)
	),
	device: Schema.optionalKey(Schema.Literals(['desktop', 'tablet', 'phone']))
});
const Input = Schema.Struct({
	url: OptionalString,
	workspace: Schema.optionalKey(Workspace),
	go: Schema.optionalKey(Schema.Literals(['back', 'forward', 'reload'])),
	steps: Schema.optionalKey(
		Schema.Array(Offered).check(Schema.isMinLength(1), Schema.isMaxLength(20))
	),
	download: OptionalString,
	evaluate: OptionalString,
	screenshot: Schema.optionalKey(Schema.Boolean),
	find: OptionalString,
	from: OptionalNumber,
	close: Schema.optionalKey(Schema.Boolean)
});
const Failed = Schema.Struct({ error: Schema.String });

/** An automation's browser identity: stable per automation (its sealed sign-ins), one tab per run. */
export const automationBrowserProfile = (automation: string, run: string): string =>
	`${BROWSER_RUN_PROFILE}${automation}\u0000${run}`;

/** One browser identity per person; each conversation gets its own session (tab) inside it. */
export const browserProfile = (actor: EngineActor, conversation: string): string | undefined =>
	actor.kind === 'member'
		? `person:${actor.id}\u0000${conversation}`
		: actor.kind === 'system'
			? `${BROWSER_RUN_PROFILE}${conversation}`
			: undefined;
const profileOf = (context: HostToolContext): string | undefined =>
	browserProfile(context.actor, context.conversation);

/** Input refusals and facility failures are answers the model can act on, never thrown. */
const tool = <A, I>(
	options: Readonly<{
		name: string;
		description: string;
		input: Schema.Codec<A, I>;
		parseOptions?: SchemaAST.ParseOptions;
		readOnly?: boolean;
		studio?: StudioRole;
		call: (
			input: A,
			profile: string,
			context: HostToolContext
		) => Effect.Effect<Json, { message: string }>;
	}>
): HostTool => ({
	name: options.name,
	description: options.description,
	input: Schema.decodeUnknownSync(Schema.Json)(
		Schema.toJsonSchemaDocument(options.input, { onExcessProperty: 'error' }).schema
	),
	...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
	...(options.studio === undefined ? {} : { studio: options.studio }),
	call: (input, context, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const profile = profileOf(context);
				if (profile === undefined)
					return { error: 'only a person or an automation run can browse' };
				const decoded = yield* Schema.decodeUnknownEffect(
					options.input,
					options.parseOptions
				)(input);
				return yield* options.call(decoded, profile, context);
			}).pipe(Effect.catch((failure) => Effect.succeed({ error: failure.message }))),
			{ signal }
		)
});

/**
 * `browser`: one call runs a whole visit, in order: open, steps, download, evaluate, screenshot. It answers the page as
 * text with a ref on every control, or `evaluate`'s value alone; `close` ends the tab.
 */
export const browserTools = (browser: Browser['Service']): readonly HostTool[] => [
	tool({
		name: 'browser',
		studio: 'view',
		description:
			"Your own separate browser, which the person does not see; it keeps your sign-ins. One call runs in order: open a url or workspace page (or go), steps, download a file url as the person's file, evaluate a script, screenshot. Answers the page as text with [ref]s, narrowed by find (words) or from (line), or evaluate's value as JSON. close ends the tab.",
		input: Input,
		parseOptions: CLOSED,
		call: (i, profile, context) =>
			Effect.gen(function* () {
				if (i.close === true) {
					if (browser.close === undefined)
						return { error: 'This host cannot close a browser tab.' };
					yield* browser.close(profile);
					return { closed: true };
				}
				let page: Json | undefined;
				if (i.workspace !== undefined) {
					if (browser.openWorkspace === undefined)
						return { error: 'This host cannot open workspace pages.' };
					page = yield* browser.openWorkspace(profile, i.workspace, {
						actor: context.actor,
						conversation: context.conversation,
						...(context.agent === undefined ? {} : { agent: context.agent })
					});
				} else if (i.url !== undefined)
					page = yield* browser.navigate(profile, { url: i.url }, i.find);
				else if (i.go !== undefined) page = yield* browser.navigate(profile, { go: i.go }, i.find);
				if (Schema.is(Failed)(page)) return page;
				if (i.steps !== undefined) {
					page = yield* browser.act(
						profile,
						yield* Schema.decodeUnknownEffect(Schema.Array(Step))(i.steps)
					);
					if (Schema.is(Failed)(page)) return page;
				}
				if (i.download !== undefined && context.keep === undefined)
					return { error: 'files are kept only in a conversation with a person' };
				const saved =
					i.download === undefined
						? undefined
						: yield* browser.download(profile, i.download).pipe(
								Effect.map((file) => {
									context.keep?.(file);
									return { saved: file.name, mime: file.mime, bytes: file.bytes };
								})
							);
				const value =
					i.evaluate === undefined
						? undefined
						: { value: yield* browser.evaluate(profile, i.evaluate) };
				// a workspace page and an asked-for screenshot arrive as an image: the person sees it and the model reads it next step
				if (i.screenshot === true || i.workspace !== undefined)
					yield* browser.screenshot(profile).pipe(
						Effect.tap((bytes) => Effect.sync(() => context.attach({ mime: 'image/png', bytes }))),
						Effect.catch(() => Effect.void)
					);
				if (value !== undefined || saved !== undefined) return { ...saved, ...value };
				const narrowed = i.find !== undefined || i.from !== undefined;
				return page !== undefined && !(narrowed && i.steps !== undefined)
					? page
					: yield* browser.snapshot(profile, {
							...(i.find === undefined ? {} : { find: i.find }),
							...(i.from === undefined ? {} : { from: i.from })
						});
			})
	})
];

/** The agent host's tools after the built-in browser tools. */
export const withBrowser = Effect.fnUntraced(function* (agent: AgentHostConfig) {
	const builtIn = browserTools(yield* Browser),
		hosted = agent.hostTools;
	return {
		...agent,
		hostTools: async (authority, conversation) => [
			...builtIn,
			...(hosted === undefined
				? []
				: typeof hosted === 'function'
					? await hosted(authority, conversation)
					: hosted)
		]
	} satisfies AgentHostConfig;
});
