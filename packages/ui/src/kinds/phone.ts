// Phone numbers as the `phone` built-in stores them: E.164 (`+6591234567`). Calling codes are ITU's (libphonenumber's
// table, inlined: a code → its regions, the main region first), so no phone library ships.
// ponytail: national digits are grouped by length, not by each region's plan; embed a region's patterns when one reads wrong.
const TABLE = '1:US AG AI AS BB BM BS CA DM DO GD GU JM KN KY LC MP MS PR SX TC TT VC VG VI;7:RU KZ;20:EG;27:ZA;30:GR;31:NL;32:BE;33:FR;34:ES;36:HU;39:IT VA;40:RO;41:CH;43:AT;44:GB GG IM JE;45:DK;46:SE;47:NO SJ;48:PL;49:DE;51:PE;52:MX;53:CU;54:AR;55:BR;56:CL;57:CO;58:VE;60:MY;61:AU CC CX;62:ID;63:PH;64:NZ;65:SG;66:TH;81:JP;82:KR;84:VN;86:CN;90:TR;91:IN;92:PK;93:AF;94:LK;95:MM;98:IR;211:SS;212:MA EH;213:DZ;216:TN;218:LY;220:GM;221:SN;222:MR;223:ML;224:GN;225:CI;226:BF;227:NE;228:TG;229:BJ;230:MU;231:LR;232:SL;233:GH;234:NG;235:TD;236:CF;237:CM;238:CV;239:ST;240:GQ;241:GA;242:CG;243:CD;244:AO;245:GW;246:IO;247:AC;248:SC;249:SD;250:RW;251:ET;252:SO;253:DJ;254:KE;255:TZ;256:UG;257:BI;258:MZ;260:ZM;261:MG;262:RE YT;263:ZW;264:NA;265:MW;266:LS;267:BW;268:SZ;269:KM;290:SH TA;291:ER;297:AW;298:FO;299:GL;350:GI;351:PT;352:LU;353:IE;354:IS;355:AL;356:MT;357:CY;358:FI AX;359:BG;370:LT;371:LV;372:EE;373:MD;374:AM;375:BY;376:AD;377:MC;378:SM;380:UA;381:RS;382:ME;383:XK;385:HR;386:SI;387:BA;389:MK;420:CZ;421:SK;423:LI;500:FK;501:BZ;502:GT;503:SV;504:HN;505:NI;506:CR;507:PA;508:PM;509:HT;590:GP BL MF;591:BO;592:GY;593:EC;594:GF;595:PY;596:MQ;597:SR;598:UY;599:CW BQ;670:TL;672:NF;673:BN;674:NR;675:PG;676:TO;677:SB;678:VU;679:FJ;680:PW;681:WF;682:CK;683:NU;685:WS;686:KI;687:NC;688:TV;689:PF;690:TK;691:FM;692:MH;850:KP;852:HK;853:MO;855:KH;856:LA;880:BD;886:TW;960:MV;961:LB;962:JO;963:SY;964:IQ;965:KW;966:SA;967:YE;968:OM;970:PS;971:AE;972:IL;973:BH;974:QA;975:BT;976:MN;977:NP;992:TJ;993:TM;994:AZ;995:GE;996:KG;998:UZ';
/** Calling code → its regions (ISO 3166-1 alpha-2), the main region first. */
export const CALLING: ReadonlyMap<string, readonly string[]> = new Map(TABLE.split(';').map((e) => {
	const [code, regions] = e.split(':');
	return [code!, regions!.split(' ')];
}));
const CODE_OF = new Map([...CALLING].flatMap(([code, regions]) => regions.map((r) => [r, code] as const)));
/** A region's calling code (`SG` → `65`). */
export const callingCode = (region: string): string | undefined => CODE_OF.get(region);

/** A number as its calling code, region (the preferred one when it shares the code) and national digits; null unless `+…`. */
export function splitPhone(text: string, prefer?: string): { code: string; region: string; national: string } | null {
	if (!text.trim().startsWith('+')) return null;
	const d = text.replace(/\D/g, '');
	for (const n of [1, 2, 3]) {
		const regions = CALLING.get(d.slice(0, n));
		if (regions !== undefined) return { code: d.slice(0, n), region: prefer !== undefined && regions.includes(prefer) ? prefer : regions[0]!, national: d.slice(n) };
	}
	return null;
}

/** Typed text as E.164: a leading `+` is international, else `region`'s code and the national digits (a trunk 0 dropped). */
export function toE164(text: string, region: string): string | null {
	const t = text.trim();
	const digits = t.replace(/\D/g, '');
	if (digits === '') return null;
	const e = t.startsWith('+') ? `+${digits}` : `+${callingCode(region) ?? ''}${digits.replace(/^0/, '')}`;
	return /^\+[1-9]\d{6,14}$/.test(e) ? e : null;
}

/** National digits grouped for reading: 3-3-4 for ten, 3-4-4 for eleven, 2-3-4 for nine, else fours from the right. */
export function groupDigits(d: string): string {
	const sizes = d.length === 10 ? [3, 3, 4] : d.length === 11 ? [3, 4, 4] : d.length === 9 ? [2, 3, 4] : null;
	if (sizes !== null) {
		let at = 0;
		return sizes.map((n) => d.slice(at, (at += n))).join(' ');
	}
	const out: string[] = [];
	for (let end = d.length; end > 0; end -= 4) out.unshift(d.slice(Math.max(0, end - 4), end));
	return out.join(' ');
}

/** An E.164 number for reading (`+65 9123 4567`); anything else as written. */
export function formatPhone(text: string): string {
	const p = splitPhone(text);
	return p === null ? text : `+${p.code} ${groupDigits(p.national)}`.trim();
}

/** The viewer's region from a locale (`en-SG` → `SG`), else `fallback`. */
export function regionOf(locale: string | undefined, fallback = 'US'): string {
	try {
		const r = locale === undefined ? undefined : new Intl.Locale(locale).maximize().region;
		return r !== undefined && CODE_OF.has(r) ? r : fallback;
	} catch {
		return fallback;
	}
}
