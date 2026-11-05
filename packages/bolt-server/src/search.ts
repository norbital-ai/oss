import { Option, Schema } from 'effect';
import type { HostTool, Json } from '@norbital-ai/bolt/engine';

const CALL_MS = 10_000;
/** DeepSeek's bound on a query, operators included. */
const QUERY_CHARS = 128;
const EXCERPT_CHARS = 600;
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const SearchInput = Schema.Struct({
	query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(QUERY_CHARS)).annotate({
		description: 'what to search for; quoted phrases and -site: work in it'
	}),
	count: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
			description: 'results, default 8'
		})
	),
	sites: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({ description: 'only these domains, e.g. ["gov.sg"]' })
	),
	after: Schema.optionalKey(IsoDate.annotate({ description: 'published after, YYYY-MM-DD' })),
	before: Schema.optionalKey(IsoDate.annotate({ description: 'published before, YYYY-MM-DD' }))
});
const Results = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			title: Schema.optionalKey(Schema.NullOr(Schema.String)),
			url: Schema.String,
			site_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
			date: Schema.optionalKey(Schema.NullOr(Schema.String)),
			snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
			summary: Schema.optionalKey(Schema.NullOr(Schema.String))
		})
	)
});

/** `web_search` on DeepSeek's search API. A refusal is the tool's answer, so the model can repair its call. */
export const webSearch = (config: { endpoint: string; credential: string }): HostTool => ({
	name: 'web_search',
	description: "Search the web. Answers the results: each one's title, url, site, date and excerpt.",
	input: Schema.decodeUnknownSync(Schema.Json)(
		Schema.toJsonSchemaDocument(SearchInput, { onExcessProperty: 'error' }).schema
	),
	readOnly: true,
	call: async (raw, context, signal): Promise<Json> => {
		const input = Schema.decodeUnknownOption(SearchInput)(raw);
		if (Option.isNone(input)) return { error: 'web_search: query is 1 to 128 characters.' };
		const { query, count = 8, sites = [], after, before } = input.value;
		const searched = [
			query,
			...sites.map((site) => `site:${site}`),
			...(after === undefined ? [] : [`after:${after}`]),
			...(before === undefined ? [] : [`before:${before}`])
		].join(' ');
		if (searched.length > QUERY_CHARS)
			return { error: `the query with its operators is over ${QUERY_CHARS} characters` };
		const response = await fetch(config.endpoint, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.credential}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				query: searched,
				count,
				...(context.question === undefined ? {} : { ori_question: context.question.slice(0, 128) })
			}),
			signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)])
		}).catch((cause: unknown) => ({ cause }));
		if ('cause' in response) return { error: `search failed: ${String(response.cause)}` };
		if (!response.ok) return { error: `search ${response.status}` };
		const answer = Schema.decodeUnknownOption(Results)(await response.json());
		if (Option.isNone(answer)) return { error: 'search answered an unknown shape' };
		const seen = new Set<string>();
		return {
			results: answer.value.results
				.filter((result) => !seen.has(result.url) && seen.add(result.url))
				.slice(0, count)
				.map((result) => ({
					title: result.title ?? '',
					url: result.url,
					...(result.site_name ? { site: result.site_name } : {}),
					...(result.date ? { date: result.date.slice(0, 10) } : {}),
					excerpt: (result.summary ?? result.snippet ?? '').slice(0, EXCERPT_CHARS)
				}))
		};
	}
});
