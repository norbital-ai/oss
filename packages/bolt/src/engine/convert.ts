// The converter behind `ctx.convert.document`: Norbital Convert (oss/services/convert), one open-source Docker service
// (pandoc + Typst) that writes every target. One call: `POST /v1/convert` queues the job and streams its states, then
// the bytes. The work runs on the service's queue, so a stream cut by a replica restarting resumes by the job's id.
import { CONVERT_TARGETS, type ConvertPort } from './contracts.ts';

/** Where the service listens (`http://convert:8080`), the API key it issued, and the fetch to reach it. */
export type DocumentConverterConfig = { url: string; key: string; fetch?: typeof fetch };

type Job = { id: string; state: 'queued' | 'running' | 'succeeded' | 'failed'; error: string | null };
type Seen = { job?: Job; bytes?: Uint8Array };

export function documentConverter(c: DocumentConverterConfig): ConvertPort {
	const f = c.fetch ?? fetch;
	const base = c.url.replace(/\/$/, '');
	const headers = { authorization: `Bearer ${c.key}` };
	/** Reads one event stream into `seen` as it arrives, so a cut stream still leaves the job's id behind. */
	async function read(res: Response, seen: Seen) {
		if (!res.ok || res.body === null) throw new Error(`the converter answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
		const decoder = new TextDecoder();
		let buffer = '';
		for await (const chunk of res.body) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
				const event = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = event.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
				if (data === undefined) continue;
				if (event.startsWith('event: job')) seen.job = JSON.parse(data) as Job;
				else if (event.startsWith('event: result')) seen.bytes = new Uint8Array(Buffer.from((JSON.parse(data) as { bytes: string }).bytes, 'base64'));
			}
		}
	}
	return {
		targets: CONVERT_TARGETS,
		async convert(source, to, options, signal) {
			const body = {
				...('markdown' in source ? { from: 'markdown', source: source.markdown } : { from: 'html', source: source.html }),
				to,
				...(options.page === undefined ? {} : { page: options.page }),
				...(options.landscape === undefined ? {} : { landscape: options.landscape }),
				...(options.reference === undefined ? {} : { reference: Buffer.from(options.reference).toString('base64') })
			};
			let seen: Seen = {};
			await read(await f(`${base}/v1/convert`, { method: 'POST', signal, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }), seen)
				.catch((e: unknown) => { if (seen.job === undefined || signal.aborted) throw e; });
			// the stream ended before the job settled: watch it again (a dropped stream is retried) until it settles
			while (seen.bytes === undefined && seen.job?.state !== 'failed') {
				signal.throwIfAborted();
				await new Promise((r) => setTimeout(r, 250));
				const again: Seen = {};
				const cut = await f(`${base}/v1/jobs/${seen.job!.id}/events?result`, { headers, signal }).then((res) => read(res, again)).then(() => false, () => true);
				if (!cut && again.job === undefined) throw new Error('the converter no longer has the job');
				seen = { ...seen, ...again };
			}
			if (seen.bytes === undefined) throw new Error(seen.job?.error ?? 'the conversion failed');
			return seen.bytes;
		}
	};
}
