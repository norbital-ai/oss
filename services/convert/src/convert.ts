// One conversion: pandoc reads Markdown or HTML and writes the target; a PDF is typeset by Typst. `--sandbox` confines
// pandoc to the files on its command line (no local reads, no fetched resources), `+RTS -M` caps its heap, and the
// process is killed at the timeout.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TARGETS = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	epub: 'application/epub+zip',
	html: 'text/html; charset=utf-8'
} as const;
export type Target = keyof typeof TARGETS;
export const PAPER = { A4: 'a4', A3: 'a3', Letter: 'us-letter' } as const;
/** Targets a reference document styles (pandoc's `--reference-doc`). */
export const STYLED: readonly Target[] = ['docx', 'pptx', 'odt'];

export type Request = { from: 'markdown' | 'html'; to: Target; source: string; page?: keyof typeof PAPER; landscape?: boolean };
export type Converter = (request: Request, reference: Uint8Array | null) => Promise<Uint8Array>;

export const pandoc = ({ timeoutMs, heap }: { timeoutMs: number; heap: string }): Converter => async (request, reference) => {
	const dir = await mkdtemp(join(tmpdir(), 'convert-'));
	try {
		const out = join(dir, `out.${request.to}`);
		const args = ['+RTS', `-M${heap}`, '-RTS', '--sandbox', '--standalone', '-f', request.from, '-o', out];
		if (request.to === 'pdf') {
			args.push('--pdf-engine=typst', '-V', `papersize=${PAPER[request.page ?? 'A4']}`);
			if (request.landscape) args.push('-V', 'header-includes=#set page(flipped: true)');
		} else args.push('-t', request.to);
		if (reference) {
			const ref = join(dir, `reference.${request.to}`);
			await writeFile(ref, reference);
			args.push(`--reference-doc=${ref}`);
		}
		await run(args, request.source, dir, timeoutMs);
		return new Uint8Array(await readFile(out));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

function run(args: string[], input: string, cwd: string, timeout: number) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn('pandoc', args, { cwd, timeout, killSignal: 'SIGKILL', stdio: ['pipe', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (code === 0) resolve();
			else if (signal === 'SIGKILL') reject(new Error(`The conversion took longer than ${timeout / 1000} s.`));
			else reject(new Error(stderr.trim() || `pandoc exited with ${code ?? signal}`));
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input);
	});
}
