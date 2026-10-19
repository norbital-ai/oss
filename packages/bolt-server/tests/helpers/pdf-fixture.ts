import { deflateSync } from 'node:zlib';

/** Small real PDF with compressed page streams, no parser or network fixture substitutes. */
export function pdfFixture(pages: readonly string[]): Uint8Array {
	const objects: Buffer[] = [];
	const put = (value: string | Buffer) => objects.push(Buffer.from(value));
	put('<< /Type /Catalog /Pages 2 0 R >>');
	put(
		`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`
	);
	put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	for (const [index, text] of pages.entries()) {
		put(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`
		);
		const escaped = text.replace(/([\\()])/g, '\\$1');
		const stream = deflateSync(`BT /F1 12 Tf 30 750 Td (${escaped}) Tj ET`);
		put(
			Buffer.concat([
				Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
				stream,
				Buffer.from('\nendstream')
			])
		);
	}
	const chunks = [Buffer.from('%PDF-1.7\n')];
	const offsets = [0];
	let offset = chunks[0]!.length;
	for (const [i, value] of objects.entries()) {
		offsets.push(offset);
		const chunk = Buffer.concat([
			Buffer.from(`${i + 1} 0 obj\n`),
			value,
			Buffer.from('\nendobj\n')
		]);
		chunks.push(chunk);
		offset += chunk.length;
	}
	chunks.push(
		Buffer.from(
			`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
				.slice(1)
				.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
				.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
		)
	);
	return new Uint8Array(Buffer.concat(chunks));
}
