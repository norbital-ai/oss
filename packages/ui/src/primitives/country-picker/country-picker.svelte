<script lang="ts" module>
	/** ISO 3166-1 alpha-2, every assigned code. Names come from `Intl.DisplayNames` in the viewer's locale; flags are the
	 * regional-indicator emoji, so neither a name table nor a flag icon set ships. */
	export const COUNTRY_CODES = 'AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO VG BN BG BF BI KH CM CA CV KY CF TD CL CN CX CC CO KM CD CG CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE ET FO FK FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SZ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM VI UY UZ VU VE VN WF EH YE ZM ZW'.split(' ');
	export const flagOf = (code: string) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
</script>

<script lang="ts">
	// An internal primitive (final-ui §7.4, id 736): a country select over `Combobox`, for a host's address or
	// jurisdiction field. The value is the alpha-2 code.
	import Combobox from '../combobox/combobox.svelte';
	import { uiText } from '../utils.js';

	let { value, onChange, locale = 'en', id, disabled = false, invalid = false, class: className }: {
		value: string | null; onChange(next: string | null): void; locale?: string; id?: string; disabled?: boolean; invalid?: boolean; class?: string;
	} = $props();
	const t = uiText();
	const options = $derived.by(() => {
		const names = new Intl.DisplayNames([locale], { type: 'region' });
		return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale))
			.map(({ code, name }) => ({ value: code, label: `${flagOf(code)} ${name}`, keywords: code }));
	});
</script>

<Combobox {options} {value} {onChange} {id} {disabled} {invalid} class={className} searchable clearable placeholder={t('select')} />
