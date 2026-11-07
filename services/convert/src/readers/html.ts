// HTML by parse5, the WHATWG parser: only the allowed elements survive, `data:` images become image files, remote ones go.
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { escape, inline, type Block, type Cell, type Images } from '../blocks.ts';

type Node5 = DefaultTreeAdapterMap['childNode'];
const DROP = new Set([
	'script', 'style', 'template', 'noscript', 'head', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas',
	'button', 'input', 'select', 'textarea', 'option', 'video', 'audio', 'map'
]);
const INLINE: Record<string, 'strong' | 'em' | 'code' | 'time' | undefined> = {
	strong: 'strong', b: 'strong', em: 'em', i: 'em', code: 'code', kbd: 'code', samp: 'code', tt: 'code', time: 'time'
};
const PHRASING = new Set(['a', 'span', 'abbr', 'cite', 'dfn', 'mark', 'q', 's', 'small', 'sub', 'sup', 'u', 'font', 'label', 'var', 'del', 'ins', 'bdi', 'bdo', 'data', 'nobr', 'wbr', 'big', 'strike']);
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const attr = (n: Node5, name: string) =>
	'attrs' in n ? n.attrs.find((a) => a.name === name)?.value : undefined;
const span = (v: string | undefined) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 1 ? Math.min(n, 1000) : 1;
};

export function html(source: string, images: Images): Block[] {
	const flow = (nodes: readonly Node5[]): Block[] => {
		const out: Block[] = [];
		let buffer = '';
		const flush = () => {
			const h = buffer.trim();
			if (h) out.push({ t: 'p', html: h });
			buffer = '';
		};
		const phrase = (n: Node5): string => {
			if (n.nodeName === '#text' && 'value' in n) return escape(n.value.replace(/\s+/g, ' '));
			if (!('tagName' in n) || DROP.has(n.tagName)) return '';
			if (n.tagName === 'br') return '<br>';
			const inner = n.childNodes.map(phrase).join('');
			const tag = INLINE[n.tagName];
			return tag === 'time'
				? inner.trim()
					? `<time>${inner}</time>`
					: ''
				: inline(inner, { strong: tag === 'strong', em: tag === 'em', code: tag === 'code' });
		};
		for (const n of nodes) {
			if (n.nodeName === '#text' || ('tagName' in n && (n.tagName in INLINE || PHRASING.has(n.tagName) || n.tagName === 'br'))) {
				buffer += phrase(n);
				continue;
			}
			if (!('tagName' in n) || DROP.has(n.tagName)) continue;
			const tag = n.tagName;
			const heading = /^h([1-6])$/.exec(tag);
			if (heading) {
				flush();
				const h = n.childNodes.map(phrase).join('').trim();
				if (h) out.push({ t: 'h', level: Number(heading[1]), html: h });
			} else if (tag === 'p') {
				flush();
				buffer = n.childNodes.map(phrase).join('');
				flush();
			} else if (tag === 'pre') {
				flush();
				const t = text(n);
				if (t.trim()) out.push({ t: 'pre', text: t });
			} else if (tag === 'ul' || tag === 'ol') {
				flush();
				const items = n.childNodes
					.filter((li) => 'tagName' in li && li.tagName === 'li')
					.map((li) => ('childNodes' in li ? flow(li.childNodes) : []))
					.filter((b) => b.length > 0);
				if (items.length) out.push({ t: 'list', ordered: tag === 'ol', items });
			} else if (tag === 'table') {
				flush();
				const rows: Cell[][] = [];
				const collect = (x: Node5) => {
					if (!('tagName' in x)) return;
					if (x.tagName === 'tr')
						rows.push(
							x.childNodes
								.filter((c) => 'tagName' in c && (c.tagName === 'td' || c.tagName === 'th'))
								.map((c) => ({
									header: 'tagName' in c && c.tagName === 'th',
									colspan: span(attr(c, 'colspan')),
									rowspan: span(attr(c, 'rowspan')),
									blocks: 'childNodes' in c ? flow(c.childNodes) : []
								}))
						);
					else if (x.tagName !== 'table' || x === n) x.childNodes.forEach(collect);
				};
				collect(n);
				if (rows.some((r) => r.length > 0)) out.push({ t: 'table', rows });
			} else if (tag === 'img') {
				const m = DATA_IMAGE.exec(attr(n, 'src') ?? '');
				if (m) {
					flush();
					out.push({
						t: 'img',
						src: images.add(Buffer.from(m[2]!, 'base64'), m[1]!.toLowerCase()),
						alt: attr(n, 'alt') ?? ''
					});
				}
			} else {
				flush();
				out.push(...flow(n.childNodes));
			}
		}
		flush();
		return out;
	};
	const text = (n: Node5): string =>
		n.nodeName === '#text' && 'value' in n ? n.value : 'childNodes' in n ? n.childNodes.map(text).join('') : '';
	return flow(parse(source).childNodes);
}
