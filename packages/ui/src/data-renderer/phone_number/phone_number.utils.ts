import {
	AsYouType,
	getExampleNumber,
	getCountries,
	getCountryCallingCode,
	parsePhoneNumberFromString,
	type CountryCode
} from 'libphonenumber-js/min';
import metadata from 'libphonenumber-js/metadata.min.json';
import examples from 'libphonenumber-js/examples.mobile.json';

interface PhoneCountryOption {
	readonly country: CountryCode;
	readonly name: string;
	readonly callingCode: string;
	readonly flag: string;
}

const PHONE_COUNTRIES = getCountries();

export function phoneCountryFromLocale(locale: string): CountryCode {
	const region = new Intl.Locale(locale).region;
	return PHONE_COUNTRIES.find((country) => country === region) ?? 'US';
}

function phoneCountryFlag(country: CountryCode): string {
	return String.fromCodePoint(...[...country].map((letter) => 127397 + letter.charCodeAt(0)));
}

export function phoneCountryOptions(locale: string): PhoneCountryOption[] {
	const names = new Intl.DisplayNames([locale], { type: 'region' });
	return getCountries()
		.map((country) => ({
			country,
			name: names.of(country) ?? country,
			callingCode: getCountryCallingCode(country),
			flag: phoneCountryFlag(country)
		}))
		.sort((left, right) => left.name.localeCompare(right.name, locale));
}

export function resolvePhoneCountry(value: string, fallback: CountryCode): CountryCode {
	if (!value.trim()) return fallback;
	const formatter = new AsYouType(fallback);
	formatter.input(value);
	const resolvedCountry = formatter.getCountry();
	if (resolvedCountry) return resolvedCountry;
	const callingCode = formatter.getCallingCode();
	if (!callingCode) return fallback;
	const callingCodeCountries = metadata.country_calling_codes[callingCode];
	return callingCodeCountries.includes(fallback) ? fallback : callingCodeCountries[0];
}

export function formatPhoneInput(value: string, country: CountryCode): string {
	if (!value.trim()) return '';
	return new AsYouType(country).input(value);
}

/** Keep only an optional leading plus and the E.164 maximum of 15 digits. */
export function sanitizePhoneInput(value: string): string {
	const hasInternationalPrefix = value.trimStart().startsWith('+');
	const digits = value.replace(/\D/g, '').slice(0, 15);
	return `${hasInternationalPrefix ? '+' : ''}${digits}`;
}

export function phoneInputPlaceholder(country: CountryCode, fallback = 'Phone number'): string {
	return getExampleNumber(country, examples)?.formatNational() ?? fallback;
}

export function normalizePhoneValue(value: string, country: CountryCode): string | null {
	const parsed = parsePhoneNumberFromString(value, country);
	return parsed?.isValid() ? parsed.number : null;
}

export function formatPhoneDisplay(value: string, country: CountryCode): string {
	const parsed = parsePhoneNumberFromString(value, country);
	return parsed?.isValid() ? parsed.formatInternational() : value;
}

export function changePhoneCountry(
	value: string,
	currentCountry: CountryCode,
	nextCountry: CountryCode
): string {
	if (!value.trim()) return '';
	const parsed = parsePhoneNumberFromString(value, currentCountry);
	let nationalNumber = parsed?.nationalNumber;
	if (!nationalNumber) {
		const digits = value.replace(/\D/g, '');
		const currentCallingCode = getCountryCallingCode(currentCountry);
		nationalNumber =
			value.trim().startsWith('+') && digits.startsWith(currentCallingCode)
				? digits.slice(currentCallingCode.length)
				: digits;
	}
	return formatPhoneInput(`+${getCountryCallingCode(nextCountry)}${nationalNumber}`, nextCountry);
}
