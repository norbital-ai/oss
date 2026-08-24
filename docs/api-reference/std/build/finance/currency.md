[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/finance/currency

# std/build/finance/currency

## Type Aliases

<a id="moneyvalue"></a>

### MoneyValue

```ts
type MoneyValue = Schema.Schema.Type<typeof MoneyValueSchema>;
```

Defined in: packages/std/build/finance/currency.d.ts:9

## Variables

<a id="currencycodeschema"></a>

### CurrencyCodeSchema

```ts
const CurrencyCodeSchema: Schema.Trim;
```

Defined in: packages/std/build/finance/currency.d.ts:3

A normalized ISO 4217 currency code shared by authored money fields and their renderers.

***

<a id="iso_currency"></a>

### ISO\_CURRENCY

```ts
const ISO_CURRENCY: readonly [{
  code: "AED";
  country: "AE";
  flag: "🇦🇪";
  name: "UAE Dirham";
  symbol: "د.إ";
}, {
  code: "AFN";
  country: "AF";
  flag: "🇦🇫";
  name: "Afghan Afghani";
  symbol: "؋";
}, {
  code: "ALL";
  country: "AL";
  flag: "🇦🇱";
  name: "Albanian Lek";
  symbol: "L";
}, {
  code: "AMD";
  country: "AM";
  flag: "🇦🇲";
  name: "Armenian Dram";
  symbol: "֏";
}, {
  code: "ANG";
  country: "CW";
  flag: "🇨🇼";
  name: "Netherlands Antillean Guilder";
  symbol: "ƒ";
}, {
  code: "AOA";
  country: "AO";
  flag: "🇦🇴";
  name: "Angolan Kwanza";
  symbol: "Kz";
}, {
  code: "ARS";
  country: "AR";
  flag: "🇦🇷";
  name: "Argentine Peso";
  symbol: "$";
}, {
  code: "AUD";
  country: "AU";
  flag: "🇦🇺";
  name: "Australian Dollar";
  symbol: "A$";
}, {
  code: "AWG";
  country: "AW";
  flag: "🇦🇼";
  name: "Aruban Florin";
  symbol: "ƒ";
}, {
  code: "AZN";
  country: "AZ";
  flag: "🇦🇿";
  name: "Azerbaijani Manat";
  symbol: "₼";
}, {
  code: "BAM";
  country: "BA";
  flag: "🇧🇦";
  name: "Bosnia and Herzegovina Convertible Mark";
  symbol: "КМ";
}, {
  code: "BBD";
  country: "BB";
  flag: "🇧🇧";
  name: "Barbadian Dollar";
  symbol: "$";
}, {
  code: "BDT";
  country: "BD";
  flag: "🇧🇩";
  name: "Bangladeshi Taka";
  symbol: "৳";
}, {
  code: "BGN";
  country: "BG";
  flag: "🇧🇬";
  name: "Bulgarian Lev";
  symbol: "лв";
}, {
  code: "BHD";
  country: "BH";
  flag: "🇧🇭";
  name: "Bahraini Dinar";
  symbol: ".د.ب";
}, {
  code: "BIF";
  country: "BI";
  flag: "🇧🇮";
  name: "Burundian Franc";
  symbol: "Fr";
}, {
  code: "BMD";
  country: "BM";
  flag: "🇧🇲";
  name: "Bermudian Dollar";
  symbol: "$";
}, {
  code: "BND";
  country: "BN";
  flag: "🇧🇳";
  name: "Brunei Dollar";
  symbol: "$";
}, {
  code: "BOB";
  country: "BO";
  flag: "🇧🇴";
  name: "Bolivian Boliviano";
  symbol: "Bs.";
}, {
  code: "BOV";
  country: "BO";
  flag: "🇧🇴";
  name: "Bolivian Mvdol";
  symbol: "¤";
}, {
  code: "BRL";
  country: "BR";
  flag: "🇧🇷";
  name: "Brazilian Real";
  symbol: "R$";
}, {
  code: "BSD";
  country: "BS";
  flag: "🇧🇸";
  name: "Bahamian Dollar";
  symbol: "$";
}, {
  code: "BTN";
  country: "BT";
  flag: "🇧🇹";
  name: "Bhutanese Ngultrum";
  symbol: "Nu.";
}, {
  code: "BWP";
  country: "BW";
  flag: "🇧🇼";
  name: "Botswana Pula";
  symbol: "P";
}, {
  code: "BYN";
  country: "BY";
  flag: "🇧🇾";
  name: "Belarusian Ruble";
  symbol: "Br";
}, {
  code: "BZD";
  country: "BZ";
  flag: "🇧🇿";
  name: "Belize Dollar";
  symbol: "$";
}, {
  code: "CAD";
  country: "CA";
  flag: "🇨🇦";
  name: "Canadian Dollar";
  symbol: "C$";
}, {
  code: "CDF";
  country: "CD";
  flag: "🇨🇩";
  name: "Congolese Franc";
  symbol: "Fr";
}, {
  code: "CHE";
  country: "CH";
  flag: "🇨🇭";
  name: "WIR Euro";
  symbol: "¤";
}, {
  code: "CHF";
  country: "CH";
  flag: "🇨🇭";
  name: "Swiss Franc";
  symbol: "Fr";
}, {
  code: "CHW";
  country: "CH";
  flag: "🇨🇭";
  name: "WIR Franc";
  symbol: "¤";
}, {
  code: "CLF";
  country: "CL";
  flag: "🇨🇱";
  name: "Chilean Unit of Account";
  symbol: "¤";
}, {
  code: "CLP";
  country: "CL";
  flag: "🇨🇱";
  name: "Chilean Peso";
  symbol: "$";
}, {
  code: "CNY";
  country: "CN";
  flag: "🇨🇳";
  name: "Chinese Yuan";
  symbol: "¥";
}, {
  code: "COP";
  country: "CO";
  flag: "🇨🇴";
  name: "Colombian Peso";
  symbol: "$";
}, {
  code: "COU";
  country: "CO";
  flag: "🇨🇴";
  name: "Unidad de Valor Real";
  symbol: "¤";
}, {
  code: "CRC";
  country: "CR";
  flag: "🇨🇷";
  name: "Costa Rican Colón";
  symbol: "₡";
}, {
  code: "CUC";
  country: "CU";
  flag: "🇨🇺";
  name: "Cuban Convertible Peso";
  symbol: "$";
}, {
  code: "CUP";
  country: "CU";
  flag: "🇨🇺";
  name: "Cuban Peso";
  symbol: "$";
}, {
  code: "CVE";
  country: "CV";
  flag: "🇨🇻";
  name: "Cape Verdean Escudo";
  symbol: "$";
}, {
  code: "CZK";
  country: "CZ";
  flag: "🇨🇿";
  name: "Czech Koruna";
  symbol: "Kč";
}, {
  code: "DJF";
  country: "DJ";
  flag: "🇩🇯";
  name: "Djiboutian Franc";
  symbol: "Fr";
}, {
  code: "DKK";
  country: "DK";
  flag: "🇩🇰";
  name: "Danish Krone";
  symbol: "kr";
}, {
  code: "DOP";
  country: "DO";
  flag: "🇩🇴";
  name: "Dominican Peso";
  symbol: "$";
}, {
  code: "DZD";
  country: "DZ";
  flag: "🇩🇿";
  name: "Algerian Dinar";
  symbol: "د.ج";
}, {
  code: "EGP";
  country: "EG";
  flag: "🇪🇬";
  name: "Egyptian Pound";
  symbol: "£";
}, {
  code: "ERN";
  country: "ER";
  flag: "🇪🇷";
  name: "Eritrean Nakfa";
  symbol: "Nfk";
}, {
  code: "ETB";
  country: "ET";
  flag: "🇪🇹";
  name: "Ethiopian Birr";
  symbol: "Br";
}, {
  code: "EUR";
  country: "DE";
  flag: "🇩🇪";
  name: "Euro";
  symbol: "€";
}, {
  code: "FJD";
  country: "FJ";
  flag: "🇫🇯";
  name: "Fijian Dollar";
  symbol: "$";
}, {
  code: "FKP";
  country: "FK";
  flag: "🇫🇰";
  name: "Falkland Islands Pound";
  symbol: "£";
}, {
  code: "GBP";
  country: "GB";
  flag: "🇬🇧";
  name: "British Pound";
  symbol: "£";
}, {
  code: "GEL";
  country: "GE";
  flag: "🇬🇪";
  name: "Georgian Lari";
  symbol: "₾";
}, {
  code: "GHS";
  country: "GH";
  flag: "🇬🇭";
  name: "Ghanaian Cedi";
  symbol: "₵";
}, {
  code: "GIP";
  country: "GI";
  flag: "🇬🇮";
  name: "Gibraltar Pound";
  symbol: "£";
}, {
  code: "GMD";
  country: "GM";
  flag: "🇬🇲";
  name: "Gambian Dalasi";
  symbol: "D";
}, {
  code: "GNF";
  country: "GN";
  flag: "🇬🇳";
  name: "Guinean Franc";
  symbol: "Fr";
}, {
  code: "GTQ";
  country: "GT";
  flag: "🇬🇹";
  name: "Guatemalan Quetzal";
  symbol: "Q";
}, {
  code: "GYD";
  country: "GY";
  flag: "🇬🇾";
  name: "Guyanese Dollar";
  symbol: "$";
}, {
  code: "HKD";
  country: "HK";
  flag: "🇭🇰";
  name: "Hong Kong Dollar";
  symbol: "HK$";
}, {
  code: "HNL";
  country: "HN";
  flag: "🇭🇳";
  name: "Honduran Lempira";
  symbol: "L";
}, {
  code: "HRK";
  country: "HR";
  flag: "🇭🇷";
  name: "Croatian Kuna";
  symbol: "kn";
}, {
  code: "HTG";
  country: "HT";
  flag: "🇭🇹";
  name: "Haitian Gourde";
  symbol: "G";
}, {
  code: "HUF";
  country: "HU";
  flag: "🇭🇺";
  name: "Hungarian Forint";
  symbol: "Ft";
}, {
  code: "IDR";
  country: "ID";
  flag: "🇮🇩";
  name: "Indonesian Rupiah";
  symbol: "Rp";
}, {
  code: "ILS";
  country: "IL";
  flag: "🇮🇱";
  name: "Israeli Shekel";
  symbol: "₪";
}, {
  code: "INR";
  country: "IN";
  flag: "🇮🇳";
  name: "Indian Rupee";
  symbol: "₹";
}, {
  code: "IQD";
  country: "IQ";
  flag: "🇮🇶";
  name: "Iraqi Dinar";
  symbol: "ع.د";
}, {
  code: "IRR";
  country: "IR";
  flag: "🇮🇷";
  name: "Iranian Rial";
  symbol: "﷼";
}, {
  code: "ISK";
  country: "IS";
  flag: "🇮🇸";
  name: "Icelandic Króna";
  symbol: "kr";
}, {
  code: "JMD";
  country: "JM";
  flag: "🇯🇲";
  name: "Jamaican Dollar";
  symbol: "$";
}, {
  code: "JOD";
  country: "JO";
  flag: "🇯🇴";
  name: "Jordanian Dinar";
  symbol: "د.ا";
}, {
  code: "JPY";
  country: "JP";
  flag: "🇯🇵";
  name: "Japanese Yen";
  symbol: "¥";
}, {
  code: "KES";
  country: "KE";
  flag: "🇰🇪";
  name: "Kenyan Shilling";
  symbol: "Sh";
}, {
  code: "KGS";
  country: "KG";
  flag: "🇰🇬";
  name: "Kyrgyzstani Som";
  symbol: "с";
}, {
  code: "KHR";
  country: "KH";
  flag: "🇰🇭";
  name: "Cambodian Riel";
  symbol: "៛";
}, {
  code: "KMF";
  country: "KM";
  flag: "🇰🇲";
  name: "Comorian Franc";
  symbol: "Fr";
}, {
  code: "KPW";
  country: "KP";
  flag: "🇰🇵";
  name: "North Korean Won";
  symbol: "₩";
}, {
  code: "KRW";
  country: "KR";
  flag: "🇰🇷";
  name: "South Korean Won";
  symbol: "₩";
}, {
  code: "KWD";
  country: "KW";
  flag: "🇰🇼";
  name: "Kuwaiti Dinar";
  symbol: "د.ك";
}, {
  code: "KYD";
  country: "KY";
  flag: "🇰🇾";
  name: "Cayman Islands Dollar";
  symbol: "$";
}, {
  code: "KZT";
  country: "KZ";
  flag: "🇰🇿";
  name: "Kazakhstani Tenge";
  symbol: "₸";
}, {
  code: "LAK";
  country: "LA";
  flag: "🇱🇦";
  name: "Lao Kip";
  symbol: "₭";
}, {
  code: "LBP";
  country: "LB";
  flag: "🇱🇧";
  name: "Lebanese Pound";
  symbol: "ل.ل";
}, {
  code: "LKR";
  country: "LK";
  flag: "🇱🇰";
  name: "Sri Lankan Rupee";
  symbol: "Rs";
}, {
  code: "LRD";
  country: "LR";
  flag: "🇱🇷";
  name: "Liberian Dollar";
  symbol: "$";
}, {
  code: "LSL";
  country: "LS";
  flag: "🇱🇸";
  name: "Lesotho Loti";
  symbol: "L";
}, {
  code: "LYD";
  country: "LY";
  flag: "🇱🇾";
  name: "Libyan Dinar";
  symbol: "ل.د";
}, {
  code: "MAD";
  country: "MA";
  flag: "🇲🇦";
  name: "Moroccan Dirham";
  symbol: "د.م.";
}, {
  code: "MDL";
  country: "MD";
  flag: "🇲🇩";
  name: "Moldovan Leu";
  symbol: "L";
}, {
  code: "MGA";
  country: "MG";
  flag: "🇲🇬";
  name: "Malagasy Ariary";
  symbol: "Ar";
}, {
  code: "MKD";
  country: "MK";
  flag: "🇲🇰";
  name: "Macedonian Denar";
  symbol: "ден";
}, {
  code: "MMK";
  country: "MM";
  flag: "🇲🇲";
  name: "Myanmar Kyat";
  symbol: "Ks";
}, {
  code: "MNT";
  country: "MN";
  flag: "🇲🇳";
  name: "Mongolian Tugrik";
  symbol: "₮";
}, {
  code: "MOP";
  country: "MO";
  flag: "🇲🇴";
  name: "Macanese Pataca";
  symbol: "P";
}, {
  code: "MRU";
  country: "MR";
  flag: "🇲🇷";
  name: "Mauritanian Ouguiya";
  symbol: "UM";
}, {
  code: "MUR";
  country: "MU";
  flag: "🇲🇺";
  name: "Mauritian Rupee";
  symbol: "₨";
}, {
  code: "MVR";
  country: "MV";
  flag: "🇲🇻";
  name: "Maldivian Rufiyaa";
  symbol: ".ރ";
}, {
  code: "MWK";
  country: "MW";
  flag: "🇲🇼";
  name: "Malawian Kwacha";
  symbol: "MK";
}, {
  code: "MXN";
  country: "MX";
  flag: "🇲🇽";
  name: "Mexican Peso";
  symbol: "$";
}, {
  code: "MXV";
  country: "MX";
  flag: "🇲🇽";
  name: "Mexican Unidad de Inversion";
  symbol: "¤";
}, {
  code: "MYR";
  country: "MY";
  flag: "🇲🇾";
  name: "Malaysian Ringgit";
  symbol: "RM";
}, {
  code: "MZN";
  country: "MZ";
  flag: "🇲🇿";
  name: "Mozambican Metical";
  symbol: "MT";
}, {
  code: "NAD";
  country: "NA";
  flag: "🇳🇦";
  name: "Namibian Dollar";
  symbol: "$";
}, {
  code: "NGN";
  country: "NG";
  flag: "🇳🇬";
  name: "Nigerian Naira";
  symbol: "₦";
}, {
  code: "NIO";
  country: "NI";
  flag: "🇳🇮";
  name: "Nicaraguan Córdoba";
  symbol: "C$";
}, {
  code: "NOK";
  country: "NO";
  flag: "🇳🇴";
  name: "Norwegian Krone";
  symbol: "kr";
}, {
  code: "NPR";
  country: "NP";
  flag: "🇳🇵";
  name: "Nepalese Rupee";
  symbol: "₨";
}, {
  code: "NZD";
  country: "NZ";
  flag: "🇳🇿";
  name: "New Zealand Dollar";
  symbol: "NZ$";
}, {
  code: "OMR";
  country: "OM";
  flag: "🇴🇲";
  name: "Omani Rial";
  symbol: "ر.ع.";
}, {
  code: "PAB";
  country: "PA";
  flag: "🇵🇦";
  name: "Panamanian Balboa";
  symbol: "B/.";
}, {
  code: "PEN";
  country: "PE";
  flag: "🇵🇪";
  name: "Peruvian Sol";
  symbol: "S/";
}, {
  code: "PGK";
  country: "PG";
  flag: "🇵🇬";
  name: "Papua New Guinean Kina";
  symbol: "K";
}, {
  code: "PHP";
  country: "PH";
  flag: "🇵🇭";
  name: "Philippine Peso";
  symbol: "₱";
}, {
  code: "PKR";
  country: "PK";
  flag: "🇵🇰";
  name: "Pakistani Rupee";
  symbol: "₨";
}, {
  code: "PLN";
  country: "PL";
  flag: "🇵🇱";
  name: "Polish Złoty";
  symbol: "zł";
}, {
  code: "PYG";
  country: "PY";
  flag: "🇵🇾";
  name: "Paraguayan Guaraní";
  symbol: "₲";
}, {
  code: "QAR";
  country: "QA";
  flag: "🇶🇦";
  name: "Qatari Riyal";
  symbol: "ر.ق";
}, {
  code: "RON";
  country: "RO";
  flag: "🇷🇴";
  name: "Romanian Leu";
  symbol: "lei";
}, {
  code: "RSD";
  country: "RS";
  flag: "🇷🇸";
  name: "Serbian Dinar";
  symbol: "дин.";
}, {
  code: "RUB";
  country: "RU";
  flag: "🇷🇺";
  name: "Russian Ruble";
  symbol: "₽";
}, {
  code: "RWF";
  country: "RW";
  flag: "🇷🇼";
  name: "Rwandan Franc";
  symbol: "Fr";
}, {
  code: "SAR";
  country: "SA";
  flag: "🇸🇦";
  name: "Saudi Riyal";
  symbol: "﷼";
}, {
  code: "SBD";
  country: "SB";
  flag: "🇸🇧";
  name: "Solomon Islands Dollar";
  symbol: "$";
}, {
  code: "SCR";
  country: "SC";
  flag: "🇸🇨";
  name: "Seychellois Rupee";
  symbol: "₨";
}, {
  code: "SDG";
  country: "SD";
  flag: "🇸🇩";
  name: "Sudanese Pound";
  symbol: "ج.س.";
}, {
  code: "SEK";
  country: "SE";
  flag: "🇸🇪";
  name: "Swedish Krona";
  symbol: "kr";
}, {
  code: "SGD";
  country: "SG";
  flag: "🇸🇬";
  name: "Singapore Dollar";
  symbol: "S$";
}, {
  code: "SHP";
  country: "SH";
  flag: "🇸🇭";
  name: "Saint Helena Pound";
  symbol: "£";
}, {
  code: "SLL";
  country: "SL";
  flag: "🇸🇱";
  name: "Sierra Leonean Leone";
  symbol: "Le";
}, {
  code: "SOS";
  country: "SO";
  flag: "🇸🇴";
  name: "Somali Shilling";
  symbol: "Sh";
}, {
  code: "SRD";
  country: "SR";
  flag: "🇸🇷";
  name: "Surinamese Dollar";
  symbol: "$";
}, {
  code: "SSP";
  country: "SS";
  flag: "🇸🇸";
  name: "South Sudanese Pound";
  symbol: "£";
}, {
  code: "STN";
  country: "ST";
  flag: "🇸🇹";
  name: "São Tomé and Príncipe Dobra";
  symbol: "Db";
}, {
  code: "SVC";
  country: "SV";
  flag: "🇸🇻";
  name: "Salvadoran Colón";
  symbol: "$";
}, {
  code: "SYP";
  country: "SY";
  flag: "🇸🇾";
  name: "Syrian Pound";
  symbol: "£S";
}, {
  code: "SZL";
  country: "SZ";
  flag: "🇸🇿";
  name: "Swazi Lilangeni";
  symbol: "L";
}, {
  code: "THB";
  country: "TH";
  flag: "🇹🇭";
  name: "Thai Baht";
  symbol: "฿";
}, {
  code: "TJS";
  country: "TJ";
  flag: "🇹🇯";
  name: "Tajikistani Somoni";
  symbol: "ЅМ";
}, {
  code: "TMT";
  country: "TM";
  flag: "🇹🇲";
  name: "Turkmenistani Manat";
  symbol: "m";
}, {
  code: "TND";
  country: "TN";
  flag: "🇹🇳";
  name: "Tunisian Dinar";
  symbol: "د.ت";
}, {
  code: "TOP";
  country: "TO";
  flag: "🇹🇴";
  name: "Tongan Paʻanga";
  symbol: "T$";
}, {
  code: "TRY";
  country: "TR";
  flag: "🇹🇷";
  name: "Turkish Lira";
  symbol: "₺";
}, {
  code: "TTD";
  country: "TT";
  flag: "🇹🇹";
  name: "Trinidad and Tobago Dollar";
  symbol: "$";
}, {
  code: "TWD";
  country: "TW";
  flag: "🇹🇼";
  name: "New Taiwan Dollar";
  symbol: "$";
}, {
  code: "TZS";
  country: "TZ";
  flag: "🇹🇿";
  name: "Tanzanian Shilling";
  symbol: "Sh";
}, {
  code: "UAH";
  country: "UA";
  flag: "🇺🇦";
  name: "Ukrainian Hryvnia";
  symbol: "₴";
}, {
  code: "UGX";
  country: "UG";
  flag: "🇺🇬";
  name: "Ugandan Shilling";
  symbol: "Sh";
}, {
  code: "USD";
  country: "US";
  flag: "🇺🇸";
  name: "US Dollar";
  symbol: "$";
}, {
  code: "USN";
  country: "US";
  flag: "🇺🇸";
  name: "US Dollar (Next day)";
  symbol: "$";
}, {
  code: "UYI";
  country: "UY";
  flag: "🇺🇾";
  name: "Uruguay Peso en Unidades Indexadas";
  symbol: "¤";
}, {
  code: "UYU";
  country: "UY";
  flag: "🇺🇾";
  name: "Uruguayan Peso";
  symbol: "$";
}, {
  code: "UYW";
  country: "UY";
  flag: "🇺🇾";
  name: "Unidad Previsional";
  symbol: "¤";
}, {
  code: "UZS";
  country: "UZ";
  flag: "🇺🇿";
  name: "Uzbekistani Som";
  symbol: "сўм";
}, {
  code: "VED";
  country: "VE";
  flag: "🇻🇪";
  name: "Venezuelan Bolívar Digital";
  symbol: "Bs.D";
}, {
  code: "VES";
  country: "VE";
  flag: "🇻🇪";
  name: "Venezuelan Bolívar Soberano";
  symbol: "Bs.S";
}, {
  code: "VND";
  country: "VN";
  flag: "🇻🇳";
  name: "Vietnamese Dong";
  symbol: "₫";
}, {
  code: "VUV";
  country: "VU";
  flag: "🇻🇺";
  name: "Vanuatu Vatu";
  symbol: "Vt";
}, {
  code: "WST";
  country: "WS";
  flag: "🇼🇸";
  name: "Samoan Tala";
  symbol: "T";
}, {
  code: "XAF";
  country: "CM";
  flag: "🇨🇲";
  name: "Central African CFA Franc";
  symbol: "Fr";
}, {
  code: "XAG";
  country: null;
  flag: null;
  name: "Silver Ounce";
  symbol: "oz";
}, {
  code: "XAU";
  country: null;
  flag: null;
  name: "Gold Ounce";
  symbol: "oz";
}, {
  code: "XBA";
  country: null;
  flag: null;
  name: "European Composite Unit";
  symbol: "¤";
}, {
  code: "XBB";
  country: null;
  flag: null;
  name: "European Monetary Unit";
  symbol: "¤";
}, {
  code: "XBC";
  country: null;
  flag: null;
  name: "European Unit of Account 9";
  symbol: "¤";
}, {
  code: "XBD";
  country: null;
  flag: null;
  name: "European Unit of Account 17";
  symbol: "¤";
}, {
  code: "XCD";
  country: "AG";
  flag: "🇦🇬";
  name: "Eastern Caribbean Dollar";
  symbol: "$";
}, {
  code: "XDR";
  country: null;
  flag: null;
  name: "Special Drawing Rights";
  symbol: "¤";
}, {
  code: "XOF";
  country: "SN";
  flag: "🇸🇳";
  name: "West African CFA Franc";
  symbol: "Fr";
}, {
  code: "XPD";
  country: null;
  flag: null;
  name: "Palladium Ounce";
  symbol: "oz";
}, {
  code: "XPF";
  country: "PF";
  flag: "🇵🇫";
  name: "CFP Franc";
  symbol: "Fr";
}, {
  code: "XPT";
  country: null;
  flag: null;
  name: "Platinum Ounce";
  symbol: "oz";
}, {
  code: "XSU";
  country: null;
  flag: null;
  name: "SUCRE";
  symbol: "¤";
}, {
  code: "XTS";
  country: null;
  flag: null;
  name: "Testing Currency Code";
  symbol: "¤";
}, {
  code: "XUA";
  country: null;
  flag: null;
  name: "ADB Unit of Account";
  symbol: "¤";
}, {
  code: "XXX";
  country: null;
  flag: null;
  name: "Unknown Currency";
  symbol: "¤";
}, {
  code: "YER";
  country: "YE";
  flag: "🇾🇪";
  name: "Yemeni Rial";
  symbol: "﷼";
}, {
  code: "ZAR";
  country: "ZA";
  flag: "🇿🇦";
  name: "South African Rand";
  symbol: "R";
}, {
  code: "ZMW";
  country: "ZM";
  flag: "🇿🇲";
  name: "Zambian Kwacha";
  symbol: "ZK";
}, {
  code: "ZWL";
  country: "ZW";
  flag: "🇿🇼";
  name: "Zimbabwean Dollar";
  symbol: "$";
}];
```

Defined in: packages/std/build/finance/currency.d.ts:18

Consolidated ISO Currency constant with all currency information
Each object contains: code, symbol, name, country, and flag

***

<a id="moneyvalueschema"></a>

### MoneyValueSchema

```ts
const MoneyValueSchema: Schema.Struct<{
  currency: Schema.Trim;
  value: Schema.Finite;
}>;
```

Defined in: packages/std/build/finance/currency.d.ts:5

The one stored and wire shape of a monetary amount.

## Functions

<a id="currencyfractiondigits"></a>

### currencyFractionDigits()

```ts
function currencyFractionDigits(currency): number;
```

Defined in: packages/std/build/finance/currency.d.ts:11

ISO 4217-style fraction digits (aligned with CLDR via common currency sets).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `currency` | `string` |

#### Returns

`number`

***

<a id="fromminorunits"></a>

### fromMinorUnits()

```ts
function fromMinorUnits(minor, currency): number;
```

Defined in: packages/std/build/finance/currency.d.ts:13

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `minor` | `bigint` |
| `currency` | `string` |

#### Returns

`number`

***

<a id="tominorunits"></a>

### toMinorUnits()

```ts
function toMinorUnits(value, currency): bigint;
```

Defined in: packages/std/build/finance/currency.d.ts:12

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `number` |
| `currency` | `string` |

#### Returns

`bigint`
