/**
 * The envelope an envoy stamps on a transport message, read back for the transcript.
 *
 * `inboundAgentInput` joins the sender, time and transport message id into the text the model
 * reads, because the model has no other field to read them from. A person reviewing the transcript
 * does have other fields — sender and time are metadata, not message text — so the envelope is
 * unwrapped here rather than shown as three lines of implementation detail. Only the exact shape
 * the runtime writes is recognized; anything else stays the message it always was.
 */
export type InboundEnvelope = Readonly<{
	readonly sender: string;
	readonly sentAt: string;
	readonly invocation: 'direct' | 'mention' | 'reply' | 'ambient';
	readonly messageId: string;
	readonly body: string;
}>;

const ENVELOPE_META =
	/^\[([^\]]+)\]\s+(.*?)\s+·\s+(direct|mention|reply|ambient)\s+·\s+chat\s+\S+\s+·\s+message\s+(\S+)(?:\s+·\s+sender\s+\S+)?\s*$/;
/** The model's attribution line, not something the sender said: the sender line already names them. */
const ACCOUNT_LINE = /^\[registered account: .+\]$/;

export function parseInboundEnvelope(text: string): InboundEnvelope | null {
	const lines = text.split('\n');
	if (lines[0]?.trim() !== 'INBOUND MESSAGE') return null;
	const meta = lines[1]?.match(ENVELOPE_META);
	if (meta == null) return null;
	const [, sentAt = '', sender = '', invocation = '', messageId = ''] = meta;
	return {
		sender,
		sentAt,
		invocation: invocation as InboundEnvelope['invocation'],
		messageId,
		body: lines
			.slice(2)
			.filter((line) => !ACCOUNT_LINE.test(line))
			.join('\n')
			.trim()
	};
}
