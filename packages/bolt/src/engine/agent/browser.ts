// The built-in `browser_*` tools: Bolt's own, over the host's browsing facility (`Browser`). A host that supplies none
// still offers them; each call answers that the browser facility is missing.
import { Effect, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { Browser } from '../ports.ts';
import type { AgentHostConfig } from './index.ts';
import type { HostTool, HostToolContext } from './tools.ts';

/** An automation run's browser profile: this prefix and the run id. The host discards it when the run's session ends. */
export const BROWSER_RUN_PROFILE = '\u0001run:';

const OptionalString = Schema.optionalKey(Schema.String),
	OptionalNumber = Schema.optionalKey(Schema.Finite);
const Step = Schema.Union([
	Schema.Struct({ click: Schema.String }),
	Schema.Struct({
		type: Schema.Struct({
			ref: Schema.String,
			text: Schema.String,
			submit: Schema.optionalKey(Schema.Boolean)
		})
	}),
	Schema.Struct({ select: Schema.Struct({ ref: Schema.String, value: Schema.String }) }),
	Schema.Struct({ press: Schema.String }),
	Schema.Struct({ hover: Schema.String }),
	Schema.Struct({ scroll: Schema.Struct({ ref: OptionalString, y: OptionalNumber }) }),
	Schema.Struct({ wait: Schema.Struct({ text: OptionalString, ms: OptionalNumber }) })
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
const Navigate = Schema.Struct({
	url: OptionalString,
	go: Schema.optionalKey(Schema.Literals(['back', 'forward', 'reload'])),
	find: OptionalString
});

/** One browser session per agent conversation; an automation run keeps its own profile too. */
const profileOf = (context: HostToolContext): string | undefined =>
	context.actor.kind === 'member'
		? `person:${context.actor.id}:${context.conversation}`
		: context.actor.kind === 'system'
			? `${BROWSER_RUN_PROFILE}${context.conversation}`
			: undefined;

/** Input refusals and facility failures are answers the model can act on, never thrown. */
const tool = <A, I>(
	options: Readonly<{
		name: string;
		description: string;
		input: Schema.Codec<A, I>;
		readOnly?: boolean;
		call: (
			input: A,
			profile: string,
			context: HostToolContext
		) => Effect.Effect<Json, { message: string }>;
	}>
): HostTool => ({
	name: options.name,
	description: options.description,
	input: Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(options.input).schema),
	...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
	call: (input, context, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const profile = profileOf(context);
				if (profile === undefined)
					return { error: 'only a person or an automation run can browse' };
				const decoded = yield* Schema.decodeUnknownEffect(options.input)(input);
				return yield* options.call(decoded, profile, context);
			}).pipe(Effect.catch((failure) => Effect.succeed({ error: failure.message }))),
			{ signal }
		)
});

export const browserTools = (browser: Browser['Service']): readonly HostTool[] => [
	tool({
		name: 'browser_navigate',
		description:
			'Open an http(s) page in your own browser (it keeps your sign-ins and site data), or go back, forward or reload. Answers the page as text with a ref on every control; a PDF answers its text, page by page. find keeps only lines with any of its words.',
		input: Navigate,
		call: ({ url, go, find }, profile) =>
			url !== undefined
				? browser.navigate(profile, { url }, find)
				: go !== undefined
					? browser.navigate(profile, { go }, find)
					: Effect.succeed({ error: 'give url, or go: back | forward | reload' })
	}),
	tool({
		name: 'browser_snapshot',
		description:
			'The open page as text: headings, text, and each control as [ref role] label = value. A long page answers next, the line to read on from; find keeps only lines with any of its words (numbered).',
		readOnly: true,
		input: Schema.Struct({ find: OptionalString, from: OptionalNumber }),
		call: (options, profile) => browser.snapshot(profile, options)
	}),
	tool({
		name: 'browser_act',
		description:
			'Act on the open page, steps in order: click, type, select, press, hover, scroll or wait. Each step waits for the page load it starts. Answers the page after, or the step that failed and the page as it stands.',
		input: Schema.Struct({
			steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(20))
		}),
		call: ({ steps }, profile) => browser.act(profile, steps)
	}),
	tool({
		name: 'browser_evaluate',
		description:
			'Run a script in the open page and answer its value as JSON: an expression, or a function that is called; async is awaited.',
		input: Schema.Struct({ expression: Schema.String }),
		call: ({ expression }, profile) => browser.evaluate(profile, expression)
	}),
	tool({
		name: 'browser_screenshot',
		description: 'See the open page: a screenshot attached to your next step.',
		readOnly: true,
		input: Schema.Struct({}),
		call: (_input, profile, context) =>
			browser.screenshot(profile).pipe(
				Effect.tap((bytes) => Effect.sync(() => context.attach({ mime: 'image/png', bytes }))),
				Effect.as({ attached: 'the screenshot is attached to your next step' })
			)
	}),
	tool({
		name: 'browser_download',
		description:
			"Save a media file (an image, audio, video or a PDF) at an http(s) URL, fetched in your own browser (its sign-ins), as the person's file: it is kept only if its bytes are media, at most 100 MiB, and offered on this step; a file field or a post takes its reference. A public file is saved with download instead.",
		input: Schema.Struct({ url: Schema.String }),
		call: ({ url }, profile, context) =>
			context.keep === undefined
				? Effect.succeed({ error: 'files are kept only in a conversation with a person' })
				: browser.download(profile, url).pipe(
						Effect.map((file) => {
							context.keep?.(file);
							return { saved: file.name, mime: file.mime, bytes: file.bytes };
						})
					)
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
