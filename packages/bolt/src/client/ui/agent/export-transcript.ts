/**
 * `/export`: the conversation as one Markdown file, written for the person tuning the agent.
 *
 * The transcript is rendered in transcript order — what was said, what was called with which
 * parameters, what came back — with a header that answers the tuning questions first: how many
 * model calls, how many of each tool, how much of the input was cached, what it cost. Nothing
 * here is new state: it is the panel's rows and usage rows, serialized.
 */
import type { PanelMessage, TurnUsageRow } from './transcript.js';

/** A tool result longer than this is cut; the point is the shape of the exchange, not the data. */
const RESULT_LIMIT = 2_000;

const json = (value: unknown): string => {
	const text = JSON.stringify(value, null, 2) ?? 'undefined';
	return text.length <= RESULT_LIMIT
		? text
		: `${text.slice(0, RESULT_LIMIT)}\n… ${text.length - RESULT_LIMIT} more characters`;
};

const fence = (language: string, body: string): string => `\`\`\`${language}\n${body}\n\`\`\``;

const author = (message: PanelMessage): string =>
	message.author.kind === 'agent' || message.author.kind === 'tool'
		? `${message.author.kind} ${message.author.id ?? ''}`.trim()
		: message.author.kind;

function renderMessage(message: PanelMessage): string {
	const lines: string[] = [];
	const tag = message.annotation?.tag;
	lines.push(
		`## ${message.sequence} · ${message.message.role} (${author(message)}${tag === undefined ? '' : `, ${tag}`})`
	);
	const content = message.message.content;
	if (typeof content === 'string') {
		lines.push(content);
		return lines.join('\n\n');
	}
	for (const part of content) {
		switch (part.type) {
			case 'text':
				lines.push(part.text);
				break;
			case 'reasoning':
				lines.push(`> *reasoning:* ${part.text.replace(/\n/g, '\n> ')}`);
				break;
			case 'tool-call':
				lines.push(`→ **${part.name}** \`${part.id}\`\n${fence('json', json(part.params))}`);
				break;
			case 'tool-result':
				lines.push(
					`← **${part.name}** \`${part.id}\`${part.isFailure ? ' **failed**' : ''}\n${fence('json', json(part.result))}`
				);
				break;
			case 'file':
				lines.push(`📎 ${part.fileName ?? part.mediaType}`);
				break;
			default:
				lines.push(`(${part.type})`);
		}
	}
	return lines.join('\n\n');
}

/** Tool calls by name, most called first. */
function toolCounts(messages: readonly PanelMessage[]): ReadonlyArray<readonly [string, number]> {
	const counts = new Map<string, number>();
	for (const { message } of messages) {
		if (typeof message.content === 'string') continue;
		for (const part of message.content)
			if (part.type === 'tool-call') counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
	}
	return [...counts].sort((left, right) => right[1] - left[1]);
}

function usageSummary(usage: readonly TurnUsageRow[]): string {
	const calls = usage.filter(({ operation }) => operation === 'language');
	if (calls.length === 0) return '';
	let input = 0;
	let cached = 0;
	let output = 0;
	const rows = calls.map((row, index) => {
		// A provider that reports only billable units has no token figures to show.
		const tokens = row.usage !== null && 'inputTokens' in row.usage ? row.usage : undefined;
		const total = tokens?.inputTokens.total ?? 0;
		const read = tokens?.inputTokens.cacheRead ?? 0;
		const out = tokens?.outputTokens.total ?? 0;
		input += total;
		cached += read;
		output += out;
		return `| ${index + 1} | ${row.model} | ${total} | ${read} | ${out} |`;
	});
	const share = input === 0 ? 0 : Math.round((cached / input) * 100);
	return [
		`Model calls: **${calls.length}** · input ${input} tokens (${share}% cached) · output ${output}`,
		'',
		'| # | model | input | cached | output |',
		'| --- | --- | --- | --- | --- |',
		...rows
	].join('\n');
}

export function exportTranscript(
	conversationId: string,
	messages: readonly PanelMessage[],
	usage: readonly TurnUsageRow[]
): string {
	const ordered = [...messages].sort((left, right) => left.sequence - right.sequence);
	const tools = toolCounts(ordered);
	return [
		`# Conversation ${conversationId}`,
		`Exported ${new Date().toISOString()} · ${ordered.length} messages`,
		usageSummary(usage),
		tools.length === 0
			? ''
			: `Tool calls: ${tools.map(([name, count]) => `${name} ×${count}`).join(', ')}`,
		...ordered.map(renderMessage)
	]
		.filter((block) => block !== '')
		.join('\n\n');
}

/** Hands the file to the browser; the name carries the conversation so exports sort together. */
export function downloadMarkdown(name: string, body: string): void {
	const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	URL.revokeObjectURL(url);
}
