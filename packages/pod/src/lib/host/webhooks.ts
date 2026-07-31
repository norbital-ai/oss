import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
	DeclaredWebhookBinding,
	HostWebhookListener,
	WebhookInboundResult
} from './types.js';

/** Where a signature is read from when the workspace declared no header of its own. */
export const DEFAULT_WEBHOOK_SIGNATURE_HEADER = 'x-signature';

function equalsInConstantTime(presented: string, expected: string): boolean {
	const left = Buffer.from(presented, 'utf8');
	const right = Buffer.from(expected, 'utf8');
	// Length is compared first because `timingSafeEqual` throws on a mismatch. Only the length of the
	// digest leaks, which is fixed by the algorithm and public anyway.
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Does this body carry a signature made with this secret?
 *
 * The one piece of the inbound path that decides whether a stranger may write to the workspace, so it
 * is small, host-side, and has no way to say "probably". It runs before `deliver`, holding a secret
 * only the host can resolve — a tenant holds none, and under Core has no socket to be signed at.
 *
 * Two encodings are accepted, and an optional `<scheme>=` label is stripped, because providers
 * disagree and the workspace declares neither: GitHub sends `sha256=<hex>`, Slack `v0=<hex>`, Shopify
 * base64. The label is bounded at 16 characters so base64's own trailing `=` padding is never mistaken
 * for one. The comparison itself is `timingSafeEqual` against the computed digest: a byte-at-a-time
 * `===` leaks how much of a guess was right, which is enough to forge a signature one byte at a time.
 *
 * Providers that sign something other than the raw body — Stripe signs `<timestamp>.<body>` — are not
 * covered by this and must not be declared as `hmac-sha256`; the host writes its own listener and
 * verifies before calling `deliver`.
 */
export function verifyWebhookSignature(params: {
	readonly body: string;
	readonly signature: string | undefined;
	readonly secret: string;
}): boolean {
	const presented = params.signature?.trim();
	if (!presented || !params.secret) return false;
	const labelled = /^([A-Za-z0-9_-]{1,16})=(.+)$/.exec(presented);
	const candidates = labelled?.[2] ? [presented, labelled[2]] : [presented];
	const digest = createHmac('sha256', params.secret).update(params.body, 'utf8').digest();
	const expected = [digest.toString('hex'), digest.toString('base64')];
	// Every pairing is evaluated rather than short-circuited, so how long this takes says nothing about
	// which encoding the caller happened to guess.
	return candidates.some((candidate) =>
		expected
			.map((value) => equalsInConstantTime(candidate.toLowerCase(), value.toLowerCase()))
			.reduce((matched, one) => matched || one, false)
	);
}

export type HttpWebhookListenerOptions = {
	/** The port this listener owns. Separate from the Pod port: it is the only public surface. */
	readonly port: number;
	readonly host?: string;
	/** Route prefix. Each binding is mounted at `<basePath>/<integration>/<binding>`. */
	readonly basePath?: string;
	/** Bodies larger than this are refused unread. Defaults to 1 MiB. */
	readonly maxBodyBytes?: number;
	readonly log?: (message: string, cause?: unknown) => void;
};

/** How a delivery's outcome becomes a status code the provider will act on. */
function statusFor(result: WebhookInboundResult): number {
	// A duplicate is a success: the provider is telling the truth about an event already handled, and
	// answering anything else asks it to keep retrying something that will never be imported again.
	if (result.status === 'imported' || result.status === 'duplicate') return 200;
	// A refusal is final — the payload does not match the binding's declared shape and never will.
	if (result.status === 'refused') return 422;
	// Everything else failed before reaching the workspace: an unknown binding or a bad signature.
	return 401;
}

async function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > limit) return null;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * The built-in webhook endpoint: one HTTP route per declared binding, on a port of its own.
 *
 * It is a *host* server, not a Pod route, and that distinction is the security model rather than a
 * layering preference. This process holds the secret; the workspace holds only its name. Pod's wiring
 * verifies the signature before the delivery crosses in, so this file never decides who may write —
 * it reads a socket, hands over raw bytes, and turns the answer into a status code.
 *
 * The routes are derived from the manifest, so a binding that is not declared has no endpoint at all
 * and a misspelled one is a 404 rather than a silent acceptance.
 */
export function httpWebhookListener(options: HttpWebhookListenerOptions): HostWebhookListener {
	const host = options.host ?? '0.0.0.0';
	const basePath = `/${(options.basePath ?? '/webhooks').replace(/^\/+|\/+$/g, '')}`;
	const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
	const log = options.log ?? ((message: string, cause?: unknown) => console.error(message, cause));

	return async (deliver, bindings) => {
		const routes = new Map<string, DeclaredWebhookBinding>(
			bindings.map((binding) => [
				`${basePath}/${encodeURIComponent(binding.integrationName)}/${encodeURIComponent(binding.bindingName)}`,
				binding
			])
		);

		const server: Server = createServer((request, response) => {
			void (async () => {
				const url = new URL(request.url ?? '/', 'http://webhook.invalid');
				const binding = routes.get(url.pathname);
				if (request.method !== 'POST' || !binding) {
					respond(response, 404);
					return;
				}
				const body = await readBody(request, maxBodyBytes);
				if (body === null) {
					respond(response, 413);
					return;
				}
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(request.headers)) {
					if (typeof value === 'string') headers[name.toLowerCase()] = value;
					else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
				}
				try {
					const result = await deliver({
						integrationName: binding.integrationName,
						bindingName: binding.bindingName,
						body,
						headers
					});
					if (result.status === 'rejected' || result.status === 'refused') {
						log(
							`[pod:webhook] ${binding.integrationName}.${binding.bindingName} ${result.status}: ${result.reason ?? 'no reason given'}`
						);
					}
					respond(response, statusFor(result));
				} catch (cause) {
					// Something inside failed after the delivery was accepted as genuine. A 500 is the honest
					// answer and asks the provider to send it again, which is what the ledger is for.
					log(`[pod:webhook] ${binding.integrationName}.${binding.bindingName} failed`, cause);
					respond(response, 500);
				}
			})();
		});

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(options.port, host, () => {
				server.off('error', reject);
				resolve();
			});
		});
		for (const path of routes.keys()) {
			console.log(`[pod:webhook] listening on http://${host}:${options.port}${path}`);
		}

		return () => {
			server.close();
		};
	};
}

/** Answers with the status and nothing else: a body here would tell a prober what it got wrong. */
function respond(response: ServerResponse, statusCode: number): void {
	response.statusCode = statusCode;
	response.end();
}
