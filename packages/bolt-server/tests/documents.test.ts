import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { extractDocumentText } from '../src/documents.ts';

/** A one-page PDF whose content stream is `content`; offsets are computed so the xref is exact. */
const pdf = (content: string) => {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	let out = '%PDF-1.4\n';
	const offsets = objects.map((body, n) => {
		const at = out.length;
		out += `${n + 1} 0 obj\n${body}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
};
const text = 'BT /F1 12 Tf 10 100 Td (Colour match trial 42 approved by the lab) Tj ET';

describe('extractDocumentText', () => {
	it.live("answers a page's text layer as it is, with no flags", () =>
		Effect.gen(function* () {
			const typed = yield* extractDocumentText(pdf(text), 'application/pdf');
			expect(typed.body).toContain('Colour match trial 42');
			expect(typed.body).not.toContain('(page has images)');
		})
	);
});
