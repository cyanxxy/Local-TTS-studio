/**
 * English speech normalization.
 *
 * One ordered scan: each pass claims the source spans it matches, and later
 * passes skip anything already claimed, so edits never overlap or cascade.
 * Pass order: phone numbers (always left verbatim), emails, URLs, currency,
 * month-name dates, numeric tokens (dates, times, ordinals, decades, units,
 * percentages, years, decimals, ranges, integers), abbreviations, Roman
 * numerals.
 *
 * A span is claimed even when the rule that owns it is disabled: the match is
 * then left verbatim instead of being handed to a more generic rule, so
 * "10:30" with only `numbers` enabled stays "10:30", not "ten:thirty".
 *
 * Numeric tokens are maximal runs of digits joined by `. , : / - – −`. A run
 * glued to a word ("A4", "mp3", "B2B", "COVID-19", "v1.2.3", "0x1F") is never
 * read, and a run that matches no known shape (versions "3.10.2", IPs, ISBNs,
 * "555-1234", "3/4", "1,23") is left alone.
 */
import type { TextEdit } from "../textEdits";
import {
  cardinalToWords,
  decadeToWords,
  decimalToWords,
  digitsToWords,
  ordinalToWords,
  yearToWords,
} from "./numberToWords";
import type { SpeechNormalizationRule } from "./types";

type Rule = SpeechNormalizationRule;

interface Piece extends TextEdit {
  reason: Rule;
}

interface Scan {
  readonly text: string;
  readonly rules: ReadonlySet<Rule>;
  /** Region reads numeric dates day first (DD/MM/YYYY). */
  readonly dayFirst: boolean;
  readonly claimed: Uint8Array;
  readonly edits: TextEdit[];
}

/** Regions whose numeric dates are written DD/MM. */
const DAY_FIRST_REGIONS: ReadonlySet<string> = new Set(["GB", "AU", "IE", "NZ", "IN", "ZA"]);

/** One inline space (regular, no-break or narrow no-break). */
const SPACE = "[ \\u00A0\\u202F]";

// ---------------------------------------------------------------------------
// Scan bookkeeping

function isFree(scan: Scan, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (scan.claimed[index]) return false;
  }
  return true;
}

/** Claims [start, end) unless any of it is taken, keeping the enabled pieces. */
function take(scan: Scan, start: number, end: number, pieces: readonly Piece[]): void {
  if (!isFree(scan, start, end)) return;
  scan.claimed.fill(1, start, end);
  for (const piece of pieces) {
    if (scan.rules.has(piece.reason)) scan.edits.push(piece);
  }
}

/** Runs a sticky pattern at `index`. */
function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

function at(pattern: RegExp, text: string, index: number): boolean {
  return matchAt(pattern, text, index) !== null;
}

/** Source span of a participating capture group (patterns using the `d` flag). */
function groupSpan(match: RegExpExecArray, group: number): [number, number] {
  return match.indices![group] as [number, number];
}

const SENTENCE_END_AFTER = /\s*$|\s+["“‘'([]?\p{Lu}/uy;

/**
 * Whether a period-final token ending at `end` also ends its sentence, i.e.
 * it is followed by the end of the text or by a capitalized word. Such a
 * token keeps its period ("etc. Then" -> "et cetera. Then").
 */
function endsSentence(text: string, end: number): boolean {
  return at(SENTENCE_END_AFTER, text, end);
}

// ---------------------------------------------------------------------------
// Dates

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBREVIATIONS: Readonly<Record<string, number>> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12,
};
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** `month` is 1-12. */
function isValidDate(day: number, month: number, year: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
    && !(month === 2 && day === 29 && !isLeapYear(year));
}

function ordinalSuffix(digits: string): string {
  const lastTwo = Number(digits.slice(-2));
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  return ["th", "st", "nd", "rd"][lastTwo % 10] ?? "th";
}

/**
 * Month-first regions say "March fifteenth, twenty twenty-four"; day-first
 * regions say "the fifteenth of March, twenty twenty-four".
 */
function spokenDate(day: number, month: number, year: number, dayFirst: boolean): string | null {
  if (!isValidDate(day, month, year)) return null;
  const dayWords = ordinalToWords(day);
  const monthName = MONTH_NAMES[month - 1];
  const yearWords = yearToWords(year);
  return dayFirst
    ? `the ${dayWords} of ${monthName}, ${yearWords}`
    : `${monthName} ${dayWords}, ${yearWords}`;
}

const THE_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}_])the${SPACE}+$`, "iu");

/** Drops the spoken "the " of a day-first date when the source already has the article ("on the 21st of May"). */
function withoutDuplicateThe(text: string, start: number, spoken: string): string {
  return spoken.startsWith("the ") && THE_BEFORE.test(text.slice(0, start)) ? spoken.slice(4) : spoken;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Speaks an ISO (YYYY-MM-DD) or slash (with a four-digit year) date. Slash
 * dates are read in the region's order, falling back to the other order when
 * only that one is a valid date. Returns null for an invalid date (left
 * verbatim) and undefined when `raw` is not date shaped.
 */
function readNumericDate(raw: string, dayFirst: boolean): string | null | undefined {
  const iso = ISO_DATE.exec(raw);
  if (iso) return spokenDate(Number(iso[3]), Number(iso[2]), Number(iso[1]), dayFirst);
  const slash = SLASH_DATE.exec(raw);
  if (!slash) return undefined;
  const first = Number(slash[1]);
  const second = Number(slash[2]);
  const year = Number(slash[3]);
  const orders = dayFirst ? [[first, second], [second, first]] : [[second, first], [first, second]];
  const [day, month] = orders.find(([d, m]) => isValidDate(d, m, year)) ?? [0, 0];
  return spokenDate(day, month, year, dayFirst);
}

const MONTH_PATTERN = `(?:(${MONTH_NAMES.join("|")})|(Sept|${
  Object.keys(MONTH_ABBREVIATIONS).filter((name) => name !== "Sept").join("|")
})(\\.?))`;
const DATE_END = "(?![\\p{L}\\p{N}_]|[.,:/\\-–−]\\d)";
const YEAR_TAIL = `(?:,?${SPACE}+(\\d{4}))?`;
/** "March 3", "Jan. 5th, 2024". Groups: month, abbr, dot, day token, day, suffix, year. */
const MONTH_DAY = new RegExp(
  `(?<![\\p{L}\\p{N}_])${MONTH_PATTERN}${SPACE}+((\\d{1,2})(st|nd|rd|th)?)${YEAR_TAIL}${DATE_END}`,
  "dgu",
);
/** "3 March 2024", "3rd of March". Groups: day token, day, suffix, of, month, abbr, dot, year. */
const DAY_MONTH = new RegExp(
  `(?<![\\p{L}\\p{N}_.,:/\\-–−$£€¥₹])((\\d{1,2})(st|nd|rd|th)?)${SPACE}+(of${SPACE}+)?${MONTH_PATTERN}${YEAR_TAIL}${DATE_END}`,
  "dgu",
);
/** "May 2024". Groups: month, abbr, dot, year. */
const MONTH_YEAR = new RegExp(
  `(?<![\\p{L}\\p{N}_])${MONTH_PATTERN}${SPACE}+((?:1[1-9]|20)\\d\\d)${DATE_END}`,
  "dgu",
);

function monthNumber(match: RegExpExecArray, nameGroup: number): number {
  const name = match[nameGroup];
  return name === undefined ? MONTH_ABBREVIATIONS[match[nameGroup + 1]] : MONTH_NAMES.indexOf(name) + 1;
}

/** Expands an abbreviated month (reason "abbreviations"); its period is kept when it ends a sentence. */
function monthPieces(text: string, match: RegExpExecArray, abbreviationGroup: number): Piece[] {
  const abbreviation = match[abbreviationGroup];
  if (abbreviation === undefined) return [];
  const [start, end] = groupSpan(match, abbreviationGroup);
  const consumeDot = match[abbreviationGroup + 1] === "." && !endsSentence(text, end + 1);
  return [{
    start,
    end: consumeDot ? end + 1 : end,
    replacement: MONTH_NAMES[MONTH_ABBREVIATIONS[abbreviation] - 1],
    reason: "abbreviations",
  }];
}

function yearPieces(match: RegExpExecArray, group: number): Piece[] {
  const year = match[group];
  if (year === undefined) return [];
  const [start, end] = groupSpan(match, group);
  return [{ start, end, replacement: yearToWords(Number(year)), reason: "dates" }];
}

function isDayOfMonth(day: string, suffix: string | undefined, month: number, year: string | undefined): boolean {
  return (suffix === undefined || suffix === ordinalSuffix(day))
    && isValidDate(Number(day), month, year === undefined ? 2000 : Number(year));
}

function scanMonthDates(scan: Scan): void {
  const { text } = scan;
  for (const match of text.matchAll(MONTH_DAY)) {
    const month = monthNumber(match, 1);
    if (!isDayOfMonth(match[5], match[6], month, match[7])) continue;
    const [dayStart, dayEnd] = groupSpan(match, 4);
    take(scan, match.index, match.index + match[0].length, [
      ...monthPieces(text, match, 2),
      { start: dayStart, end: dayEnd, replacement: ordinalToWords(match[5]), reason: "dates" },
      ...yearPieces(match, 7),
    ]);
  }
  for (const match of text.matchAll(DAY_MONTH)) {
    const month = monthNumber(match, 5);
    if (!isDayOfMonth(match[2], match[3], month, match[8])) continue;
    const [dayStart, dayEnd] = groupSpan(match, 1);
    const dayWords = withoutDuplicateThe(
      text,
      dayStart,
      `the ${ordinalToWords(match[2])}${match[4] === undefined ? " of" : ""}`,
    );
    take(scan, match.index, match.index + match[0].length, [
      { start: dayStart, end: dayEnd, replacement: dayWords, reason: "dates" },
      ...monthPieces(text, match, 6),
      ...yearPieces(match, 8),
    ]);
  }
  for (const match of text.matchAll(MONTH_YEAR)) {
    take(scan, match.index, match.index + match[0].length, [
      ...monthPieces(text, match, 2),
      ...yearPieces(match, 4),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Phone numbers, emails and URLs

/** Phone numbers are never read as quantities; they stay verbatim. */
const PHONE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:\\+\\d{1,3}(?:[ .\\-]\\d{1,4}){2,5}|(?:\\+\\d{1,3}${SPACE}?)?\\(\\d{2,4}\\)${SPACE}?\\d{3,4}[ .\\-]\\d{4}|\\d{3}[ .\\-]\\d{3}[ .\\-]\\d{4})(?![\\p{L}\\p{N}_])`,
  "gu",
);

const EMAIL = /(?<![\p{L}\p{N}_.%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\p{L}\p{N}_-])/gu;
const SCHEME_URL = /(?<![\p{L}\p{N}_@./-])(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
/** Bare domains need a known TLD and must be lowercase, to avoid "end.Then" style typos. */
const BARE_DOMAIN = /(?<![\p{L}\p{N}_@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|ai|app|edu|gov|co|uk|de|fr|nl|ca|au|us|info|me)(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}])(?:\/[^\s<>"'`]*)?/gu;
const URL_PARTS = /^(?:https?:\/\/)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::(\d{1,5}))?((?:\/[^?#]*)?)(?:[?#].*)?$/i;
/**
 * Paths are read only when short and simple: at most three segments of up to
 * 24 URL-safe characters. Anything longer (hashes, tracking paths) is
 * dropped and only the host is read. Queries and fragments are never read.
 */
const MAX_URL_SEGMENTS = 3;
const URL_SEGMENT = /^[A-Za-z0-9._~-]{1,24}$/;
const URL_TRAILING_PUNCTUATION = ".,;:!?'\"]}>";
const ADDRESS_SEPARATORS: ReadonlyMap<string, string> = new Map([
  [".", "dot"],
  ["-", "dash"],
  ["_", "underscore"],
  ["~", "tilde"],
  ["+", "plus"],
  ["%", "percent"],
]);

/** "jane.doe" -> "jane dot doe"; digit runs are read digit by digit. */
function speakAddressPart(part: string): string {
  return part
    .split(/([._~+%-])/)
    .filter(Boolean)
    .map((token) => ADDRESS_SEPARATORS.get(token) ?? (/^\d+$/.test(token) ? digitsToWords(token) : token))
    .join(" ");
}

function speakHost(host: string): string {
  return host
    .split(".")
    .map((label) => (label.toLowerCase() === "www" ? "w w w" : speakAddressPart(label)))
    .join(" dot ");
}

function countOf(text: string, character: string): number {
  return text.split(character).length - 1;
}

/** Sentence punctuation and unbalanced closing parentheses are not part of a URL. */
function trimUrl(url: string): string {
  let trimmed = url;
  while (
    URL_TRAILING_PUNCTUATION.includes(trimmed.at(-1) as string)
    || (trimmed.endsWith(")") && countOf(trimmed, ")") > countOf(trimmed, "("))
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/** Drops the scheme; returns undefined when the host is not a dotted name. */
function speakUrl(url: string): string | undefined {
  const parts = URL_PARTS.exec(url);
  if (!parts) return undefined;
  const [, host, port, path] = parts;
  let spoken = speakHost(host);
  if (port !== undefined) spoken += ` colon ${digitsToWords(port)}`;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= MAX_URL_SEGMENTS && segments.every((segment) => URL_SEGMENT.test(segment))) {
    spoken += segments.map((segment) => ` slash ${speakAddressPart(segment)}`).join("");
  }
  return spoken;
}

function scanAddresses(scan: Scan): void {
  const { text } = scan;
  for (const match of text.matchAll(PHONE)) {
    take(scan, match.index, match.index + match[0].length, []);
  }
  for (const match of text.matchAll(EMAIL)) {
    const end = match.index + match[0].length;
    const replacement = `${speakAddressPart(match[1])} at ${speakHost(match[2])}`;
    take(scan, match.index, end, [{ start: match.index, end, replacement, reason: "emails" }]);
  }
  for (const pattern of [SCHEME_URL, BARE_DOMAIN]) {
    for (const match of text.matchAll(pattern)) {
      const url = trimUrl(match[0]);
      const end = match.index + url.length;
      const spoken = speakUrl(url);
      take(scan, match.index, end, spoken === undefined
        ? []
        : [{ start: match.index, end, replacement: spoken, reason: "urls" }]);
    }
  }
}

// ---------------------------------------------------------------------------
// Currency

interface Currency {
  one: string;
  many: string;
  /** Minor unit [singular, plural]; absent when amounts have no minor unit. */
  minor?: readonly [string, string];
}

const DOLLAR: Currency = { one: "dollar", many: "dollars", minor: ["cent", "cents"] };
const POUND: Currency = { one: "pound", many: "pounds", minor: ["penny", "pence"] };
const EURO: Currency = { one: "euro", many: "euros", minor: ["cent", "cents"] };
const YEN: Currency = { one: "yen", many: "yen" };
const RUPEE: Currency = { one: "rupee", many: "rupees", minor: ["paisa", "paise"] };
/** "$" is always read as dollars and "¥" as yen. */
const CURRENCIES: Readonly<Record<string, Currency>> = {
  $: DOLLAR,
  USD: DOLLAR,
  CAD: { one: "Canadian dollar", many: "Canadian dollars", minor: ["cent", "cents"] },
  AUD: { one: "Australian dollar", many: "Australian dollars", minor: ["cent", "cents"] },
  "£": POUND,
  GBP: POUND,
  "€": EURO,
  EUR: EURO,
  "¥": YEN,
  JPY: YEN,
  "₹": RUPEE,
  INR: RUPEE,
};
const MAGNITUDES: Readonly<Record<string, string>> = {
  k: "thousand",
  K: "thousand",
  m: "million",
  M: "million",
  mn: "million",
  B: "billion",
  bn: "billion",
  thousand: "thousand",
  million: "million",
  billion: "billion",
  trillion: "trillion",
};
const CURRENCY_CODES = "USD|EUR|GBP|JPY|INR|CAD|AUD";
const AMOUNT = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?";
/** Attached letters ("$3k", "$1.5M", "$2bn") or a spaced word ("$4 million"). */
const MAGNITUDE = `(?:(mn|bn|k|K|m|M|B)|${SPACE}(thousand|million|billion|trillion))?`;
/** "$3.50", "USD 100". Groups: symbol, code, whole, fraction, magnitude letter, magnitude word. */
const CURRENCY_PREFIX = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:([$£€¥₹])|(${CURRENCY_CODES})${SPACE}?)${AMOUNT}${MAGNITUDE}(?![\\p{L}\\p{N}_]|[.,]\\d)`,
  "gu",
);
/** "100 EUR". Groups: whole, fraction, magnitude letter, magnitude word, code. */
const CURRENCY_SUFFIX = new RegExp(
  `(?<![\\p{L}\\p{N}_.,$£€¥₹])${AMOUNT}${MAGNITUDE}${SPACE}?(${CURRENCY_CODES})(?![\\p{L}\\p{N}_])`,
  "gu",
);

/**
 * "$3.50" -> "three dollars and fifty cents"; exactly two fraction digits
 * select minor units. Other fractions and magnitudes are read as decimals
 * ("$1.5M" -> "one point five million dollars").
 */
function spokenAmount(code: string, whole: string, fraction: string | undefined, magnitude: string | undefined): string {
  const currency = CURRENCIES[code];
  const digits = whole.replace(/,/g, "");
  const amount = fraction === undefined ? digits : `${digits}.${fraction}`;
  if (magnitude !== undefined) return `${decimalToWords(amount)} ${MAGNITUDES[magnitude]} ${currency.many}`;
  const majorWords = `${cardinalToWords(digits)} ${digits === "1" ? currency.one : currency.many}`;
  if (fraction === undefined) return majorWords;
  const minor = currency.minor;
  if (minor === undefined || fraction.length !== 2) return `${decimalToWords(amount)} ${currency.many}`;
  const cents = Number(fraction);
  const parts: string[] = [];
  if (cents === 0 || /[1-9]/.test(digits)) parts.push(majorWords);
  if (cents > 0) parts.push(`${cardinalToWords(cents)} ${cents === 1 ? minor[0] : minor[1]}`);
  return parts.join(" and ");
}

function scanCurrency(scan: Scan): void {
  const { text } = scan;
  const add = (start: number, end: number, replacement: string) => {
    take(scan, start, end, [{ start, end, replacement, reason: "currency" }]);
  };
  for (const match of text.matchAll(CURRENCY_PREFIX)) {
    const [, symbol, code, whole, fraction, letter, word] = match;
    add(match.index, match.index + match[0].length, spokenAmount(symbol ?? code, whole, fraction, letter ?? word));
  }
  for (const match of text.matchAll(CURRENCY_SUFFIX)) {
    const [, whole, fraction, letter, word, code] = match;
    add(match.index, match.index + match[0].length, spokenAmount(code, whole, fraction, letter ?? word));
  }
}

// ---------------------------------------------------------------------------
// Heights

/** Feet, a prime or apostrophe, inches and an optional closing inch mark: 4'11", 5'0", 5'11. */
const HEIGHT = new RegExp(
  `(?<![\\p{L}\\p{N}_.,:/\\-–−'’′])(\\d{1,2})['’′](\\d{1,2})(["”″]|''|’’)?(?![\\p{L}\\p{N}_])`,
  "gu",
);

/**
 * "4'11\"" -> "four foot eleven". Anything else of that shape (no closing
 * inch mark, 12 or more inches) stays verbatim as a whole, instead of having
 * its digits read around the marks.
 */
function scanHeights(scan: Scan): void {
  for (const match of scan.text.matchAll(HEIGHT)) {
    const end = match.index + match[0].length;
    const isHeight = match[3] !== undefined && Number(match[2]) <= 11;
    const spoken = `${cardinalToWords(match[1])} foot ${cardinalToWords(String(Number(match[2])))}`;
    take(scan, match.index, end, isHeight ? [{ start: match.index, end, replacement: spoken, reason: "units" }] : []);
  }
}

// ---------------------------------------------------------------------------
// Numeric tokens

const NUMBER_TOKEN = /\d+(?:[.,:/\-–−]\d+)*/gu;
const INTEGER = /^\d+$/;
const GROUPED_INTEGER = /^\d{1,3}(?:,\d{3})+$/;
const DECIMAL = /^(\d+|\d{1,3}(?:,\d{3})+)\.(\d+)$/;
const RANGE = /^(0|[1-9]\d{0,3})[-–](0|[1-9]\d{0,3})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const YEAR_DIGITS = /^(?:1[1-9]|20)\d\d$/;
const DECADE_DIGITS = /^[1-9]\d{0,2}0$/;

/** A word character, or a joiner and then a word character, right before the token. */
const GLUED_BEFORE = /(?<=[\p{L}\p{N}_][.,:/\-–−]?)/uy;
/** A word character right after, or `. , : / −` and then one. A hyphen + word stays readable ("19-year-old"). */
const GLUED_AFTER = /[\p{L}\p{N}_]|[.,:/−][\p{L}\p{N}_]/uy;
/** A minus sign that is not inside a word or between numbers. */
const MINUS_BEFORE = /(?<=(?:^|[^\p{L}\p{N}_.,:/\-–−])[-−])/uy;
const POINT_BEFORE = /(?<=(?:^|[^\p{L}\p{N}_.,:/\-–−])\.)/uy;
const APOSTROPHE_BEFORE = /(?<=(?:^|[^\p{L}\p{N}_])['’])/uy;
const MERIDIEM = new RegExp(`${SPACE}?(?:([AaPp])\\.[Mm]\\.|([AaPp])[Mm])(?![\\p{L}\\p{N}_])`, "uy");
const ORDINAL_AFTER = /(st|nd|rd|th)(?![\p{L}\p{N}_])/iuy;
const DECADE_AFTER = /['’]?s(?![\p{L}\p{N}_])/uy;
const PERCENT_AFTER = new RegExp(`${SPACE}?%`, "uy");
/** Words that make a following 1100-2099 a year ("in 1990", "the 1984 Olympics"). */
const YEAR_CONTEXT_BEFORE = new RegExp(
  `(?<=(?:^|[^\\p{L}\\p{N}_])(?:in|since|by|from|until|till|during|of|circa|c\\.|ca\\.|year|the)${SPACE}+)`,
  "iuy",
);
/** Words that make a following number a plain cardinal ("page 1234", "No. 1984"). */
const CARDINAL_CONTEXT_BEFORE = new RegExp(
  `(?<=(?:^|[^\\p{L}\\p{N}_])(?:page|pages|p\\.|pp\\.|no\\.|number|room|flight|route|unit|suite|step|item|model|line|ext\\.)${SPACE}*)`,
  "iuy",
);
const LOWERCASE_WORD_AFTER = /\s+\p{Ll}/uy;

/** Unit symbol -> [singular, plural]. */
const UNITS: Readonly<Record<string, readonly [string, string]>> = {
  km: ["kilometer", "kilometers"],
  m: ["meter", "meters"],
  cm: ["centimeter", "centimeters"],
  mm: ["millimeter", "millimeters"],
  kg: ["kilogram", "kilograms"],
  g: ["gram", "grams"],
  mg: ["milligram", "milligrams"],
  lb: ["pound", "pounds"],
  lbs: ["pound", "pounds"],
  oz: ["ounce", "ounces"],
  mi: ["mile", "miles"],
  ft: ["foot", "feet"],
  mph: ["mile per hour", "miles per hour"],
  "km/h": ["kilometer per hour", "kilometers per hour"],
  kph: ["kilometer per hour", "kilometers per hour"],
  "°C": ["degree Celsius", "degrees Celsius"],
  "°F": ["degree Fahrenheit", "degrees Fahrenheit"],
  "°": ["degree", "degrees"],
  ms: ["millisecond", "milliseconds"],
  s: ["second", "seconds"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  hr: ["hour", "hours"],
  kB: ["kilobyte", "kilobytes"],
  KB: ["kilobyte", "kilobytes"],
  MB: ["megabyte", "megabytes"],
  GB: ["gigabyte", "gigabytes"],
  TB: ["terabyte", "terabytes"],
  Hz: ["hertz", "hertz"],
  kHz: ["kilohertz", "kilohertz"],
  MHz: ["megahertz", "megahertz"],
  GHz: ["gigahertz", "gigahertz"],
  W: ["watt", "watts"],
  kW: ["kilowatt", "kilowatts"],
  V: ["volt", "volts"],
  mAh: ["milliamp hour", "milliamp hours"],
  L: ["liter", "liters"],
  ml: ["milliliter", "milliliters"],
  mL: ["milliliter", "milliliters"],
};
/**
 * "m" and "s" are units only when glued to the number ("5m", "10s"): spaced
 * they are too often words or initials. "in" is never treated as inches.
 */
const GLUED_ONLY_UNITS: ReadonlySet<string> = new Set(["m", "s"]);
const UNIT_AFTER = new RegExp(
  `(${SPACE}?)(${Object.keys(UNITS).sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}\\p{N}_]|\\/[\\p{L}\\p{N}])`,
  "uy",
);

interface Quantity {
  /** Start including a minus sign or leading point. */
  start: number;
  spoken: string;
  singular: boolean;
  reason: Rule;
  /** Digits of a non-negative plain integer (commas removed). */
  integer?: string;
}

/** Integers with a leading zero are codes and read digit by digit ("007"). */
function integerWords(digits: string): string {
  return /^0\d/.test(digits) ? digitsToWords(digits) : cardinalToWords(digits);
}

function isYearNumber(digits: string): boolean {
  return YEAR_DIGITS.test(digits);
}

/**
 * Plain quantities: integers, decimals and ranges. A range is "a-b" or "a–b"
 * with a < b, up to four digits per side and no leading zeros, and never
 * three-then-four digits (phone-like "555-1234"). Four-digit pairs must both
 * be years ("1990-1995" -> "nineteen ninety to nineteen ninety-five"), so
 * serial-like "1234-5678" stays verbatim. "3-5" -> "three to five".
 */
function readQuantity(text: string, raw: string, start: number): Quantity | undefined {
  if (at(POINT_BEFORE, text, start)) {
    if (!INTEGER.test(raw)) return undefined;
    return { start: start - 1, spoken: decimalToWords(`.${raw}`), singular: false, reason: "decimals" };
  }
  const negative = at(MINUS_BEFORE, text, start);
  const signedStart = negative ? start - 1 : start;
  const sign = negative ? "minus " : "";
  if (INTEGER.test(raw) || GROUPED_INTEGER.test(raw)) {
    const digits = raw.replace(/,/g, "");
    return {
      start: signedStart,
      spoken: sign + integerWords(digits),
      singular: digits === "1",
      reason: "numbers",
      integer: negative ? undefined : digits,
    };
  }
  const decimal = DECIMAL.exec(raw);
  if (decimal) {
    const spoken = decimalToWords(`${decimal[1].replace(/,/g, "")}.${decimal[2]}`);
    return { start: signedStart, spoken: sign + spoken, singular: false, reason: "decimals" };
  }
  const range = RANGE.exec(raw);
  if (!range) return undefined;
  const [, low, high] = range;
  if (Number(low) >= Number(high) || (low.length === 3 && high.length === 4)) return undefined;
  const years = isYearNumber(low) && isYearNumber(high);
  if (low.length === 4 && high.length === 4 && !years) return undefined;
  const say = (digits: string) => (years ? yearToWords(Number(digits)) : cardinalToWords(digits));
  return { start, spoken: `${say(low)} to ${say(high)}`, singular: false, reason: years ? "years" : "numbers" };
}

/**
 * Clock times: "10:30" -> "ten thirty", "9:05" -> "nine oh five", "12:00" ->
 * "twelve o'clock", "23:00" -> "twenty-three hundred", "10:30 a.m." -> "ten
 * thirty AM". Seconds are appended when non-zero.
 */
function clockWords(hour: number, minute: number, twelveHour: boolean): string {
  const hourWords = cardinalToWords(hour);
  if (minute === 0) {
    if (twelveHour) return hourWords;
    return hour >= 1 && hour <= 12 ? `${hourWords} o'clock` : `${hourWords} hundred`;
  }
  return `${hourWords}${minute < 10 ? " oh" : ""} ${cardinalToWords(minute)}`;
}

/** AM/PM; a dotted "p.m." keeps its final period when it ends a sentence. */
function meridiemPiece(text: string, start: number, spoken: string, meridiem: RegExpExecArray): Piece {
  const letter = meridiem[1] ?? meridiem[2];
  const end = meridiem.index + meridiem[0].length;
  const keepPeriod = meridiem[1] !== undefined && endsSentence(text, end);
  return {
    start,
    end: keepPeriod ? end - 1 : end,
    replacement: `${spoken} ${letter.toUpperCase()}M`,
    reason: "times",
  };
}

function readTime(text: string, start: number, end: number, time: RegExpExecArray): Piece | undefined {
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = Number(time[3] ?? "0");
  const meridiem = matchAt(MERIDIEM, text, end);
  const validHour = meridiem ? hour >= 1 && hour <= 12 : hour <= 23;
  if (!validHour || minute > 59 || second > 59) return undefined;
  let spoken = clockWords(hour, minute, meridiem !== null);
  if (second > 0) spoken += ` and ${cardinalToWords(second)} ${second === 1 ? "second" : "seconds"}`;
  if (meridiem) return meridiemPiece(text, start, spoken, meridiem);
  return at(GLUED_AFTER, text, end) ? undefined : { start, end, replacement: spoken, reason: "times" };
}

/** Suffixes only a plain non-negative integer takes: "7 PM", "21st", "1990s". */
function readIntegerSuffix(text: string, digits: string, start: number, end: number): Piece | undefined {
  const meridiem = matchAt(MERIDIEM, text, end);
  const hour = Number(digits);
  if (meridiem && digits.length <= 2 && hour >= 1 && hour <= 12) {
    return meridiemPiece(text, start, cardinalToWords(hour), meridiem);
  }
  const ordinal = matchAt(ORDINAL_AFTER, text, end);
  if (ordinal && ordinal[1].toLowerCase() === ordinalSuffix(digits)) {
    return { start, end: ordinal.index + ordinal[0].length, replacement: ordinalToWords(digits), reason: "ordinals" };
  }
  const decade = matchAt(DECADE_AFTER, text, end);
  if (decade && DECADE_DIGITS.test(digits)) {
    return {
      start: at(APOSTROPHE_BEFORE, text, start) ? start - 1 : start,
      end: decade.index + decade[0].length,
      replacement: decadeToWords(Number(digits)),
      reason: "years",
    };
  }
  return undefined;
}

/**
 * Standalone policy for four-digit 1100-2099: a year after a year cue ("in",
 * "since", "the", ...), a cardinal after a counting cue ("page", "No.",
 * "room", ...), otherwise a year unless a lowercase word follows. So "Born
 * 1984." and "(2024)" are years while "2024 apples" is a cardinal; "1,500"
 * (grouped) is always a cardinal.
 */
function isYearToken(text: string, digits: string, start: number, end: number): boolean {
  if (!isYearNumber(digits)) return false;
  if (at(YEAR_CONTEXT_BEFORE, text, start)) return true;
  return !at(CARDINAL_CONTEXT_BEFORE, text, start) && !at(LOWERCASE_WORD_AFTER, text, end);
}

function readNumber(scan: Scan, raw: string, start: number, end: number): Piece | undefined {
  const { text } = scan;
  if (at(GLUED_BEFORE, text, start)) return undefined;
  const time = TIME.exec(raw);
  if (time) return readTime(text, start, end, time);
  const date = readNumericDate(raw, scan.dayFirst);
  if (date !== undefined) {
    if (date === null || at(GLUED_AFTER, text, end)) return undefined;
    return { start, end, replacement: withoutDuplicateThe(text, start, date), reason: "dates" };
  }
  const quantity = readQuantity(text, raw, start);
  if (!quantity) return undefined;
  if (quantity.integer !== undefined) {
    const suffixed = readIntegerSuffix(text, quantity.integer, start, end);
    if (suffixed) return suffixed;
  }
  const unit = matchAt(UNIT_AFTER, text, end);
  if (unit && !(unit[1] && GLUED_ONLY_UNITS.has(unit[2]))) {
    const [one, many] = UNITS[unit[2]];
    return {
      start: quantity.start,
      end: unit.index + unit[0].length,
      replacement: `${quantity.spoken} ${quantity.singular ? one : many}`,
      reason: "units",
    };
  }
  const percent = matchAt(PERCENT_AFTER, text, end);
  if (percent) {
    return { start: quantity.start, end: percent.index + percent[0].length, replacement: `${quantity.spoken} percent`, reason: "percentages" };
  }
  if (at(GLUED_AFTER, text, end)) return undefined;
  if (quantity.integer !== undefined && isYearToken(text, raw, start, end)) {
    return { start, end, replacement: yearToWords(Number(raw)), reason: "years" };
  }
  return { start: quantity.start, end, replacement: quantity.spoken, reason: quantity.reason };
}

function scanNumbers(scan: Scan): void {
  for (const match of scan.text.matchAll(NUMBER_TOKEN)) {
    const piece = readNumber(scan, match[0], match.index, match.index + match[0].length);
    if (piece) take(scan, piece.start, piece.end, [piece]);
  }
}

// ---------------------------------------------------------------------------
// Abbreviations

type AbbreviationKind = "title" | "fixed" | "trailing" | "number" | "saint";

/**
 * - title: only before a capitalized word ("Dr. Smith"); the period is consumed.
 * - fixed: always expanded, period consumed ("e.g.", "vs.").
 * - trailing: may end a sentence, then the period is kept ("etc. Then").
 * - number: "No." only before a space and a digit ("No. 5").
 * - saint: "St." is Saint before a capitalized word (unless it follows a
 *   house number and street name: "42 Main St. Then"), otherwise Street
 *   after a word or number ("Main St."); elsewhere it is left alone.
 */
const ABBREVIATIONS: Readonly<Record<string, readonly [AbbreviationKind, string]>> = {
  Dr: ["title", "Doctor"],
  Mr: ["title", "Mister"],
  Mrs: ["title", "Missus"],
  Ms: ["title", "Miz"],
  Prof: ["title", "Professor"],
  Mt: ["title", "Mount"],
  St: ["saint", "Saint"],
  No: ["number", "Number"],
  no: ["number", "number"],
  vs: ["fixed", "versus"],
  approx: ["fixed", "approximately"],
  "e.g": ["fixed", "for example"],
  "i.e": ["fixed", "that is"],
  etc: ["trailing", "et cetera"],
  Jr: ["trailing", "Junior"],
  Sr: ["trailing", "Senior"],
  Inc: ["trailing", "Incorporated"],
  Ltd: ["trailing", "Limited"],
  Co: ["trailing", "Company"],
  Corp: ["trailing", "Corporation"],
  Dept: ["trailing", "Department"],
  Ave: ["trailing", "Avenue"],
};
const ABBREVIATION = new RegExp(
  `(?<![\\p{L}\\p{N}_.])(${
    Object.keys(ABBREVIATIONS).sort((a, b) => b.length - a.length).map((key) => key.replace(".", "\\.")).join("|")
  })\\.`,
  "gu",
);
const CAPITALIZED_WORD_AFTER = new RegExp(`${SPACE}+\\p{Lu}`, "uy");
const DIGIT_AFTER = new RegExp(`${SPACE}\\d`, "uy");
const WORD_SPACE_BEFORE = new RegExp(`(?<=[\\p{L}\\p{N}]${SPACE}+)`, "uy");
const ADDRESS_BEFORE = new RegExp(`(?<=\\p{N}[\\p{L}\\p{N}]*${SPACE}+\\p{Lu}\\p{L}*${SPACE}+)`, "uy");

function scanAbbreviations(scan: Scan): void {
  const { text } = scan;
  const add = (start: number, end: number, replacement: string) => {
    take(scan, start, end, [{ start, end, replacement, reason: "abbreviations" }]);
  };
  const addTrailing = (start: number, end: number, replacement: string) => {
    add(start, endsSentence(text, end) ? end - 1 : end, replacement);
  };
  for (const match of text.matchAll(ABBREVIATION)) {
    const [kind, expansion] = ABBREVIATIONS[match[1]];
    const start = match.index;
    const end = start + match[0].length;
    switch (kind) {
      case "title":
        if (at(CAPITALIZED_WORD_AFTER, text, end)) add(start, end, expansion);
        break;
      case "number":
        if (at(DIGIT_AFTER, text, end)) add(start, end, expansion);
        break;
      case "fixed":
        add(start, end, expansion);
        break;
      case "trailing":
        addTrailing(start, end, expansion);
        break;
      case "saint":
        if (at(CAPITALIZED_WORD_AFTER, text, end) && !at(ADDRESS_BEFORE, text, start)) {
          add(start, end, expansion);
        } else if (at(WORD_SPACE_BEFORE, text, start)) {
          addTrailing(start, end, "Street");
        }
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Roman numerals

/** Keywords read a following numeral as a cardinal ("Chapter IV" -> "Chapter four"). */
const ROMAN_KEYWORDS = [
  "Chapter", "Part", "Book", "Volume", "Vol.", "Act", "Scene", "Section", "Appendix",
  "War", "Type", "Class", "Phase", "Stage", "Level", "Episode", "Season", "Article",
];
/** Uppercase tokens made only of Roman digits; the preceding word decides how they read. */
const ROMAN_TOKEN = /(?<![\p{L}\p{N}_])[IVXLCDM]+(?![\p{L}\p{N}_])/gu;
/** Groups: keyword, spaces. */
const KEYWORD_BEFORE = new RegExp(
  `(?<=(?<![\\p{L}\\p{N}_])(${
    ROMAN_KEYWORDS.flatMap((word) => [word, word.toLowerCase(), word.toUpperCase()])
      .map((word) => word.replace(".", "\\."))
      .join("|")
  })(${SPACE}+))`,
  "uy",
);
/** A capitalized name then II-XXXIX: "Henry VIII" -> "Henry the Eighth". */
const NAME_BEFORE = new RegExp(`(?<=(?<![\\p{L}\\p{N}_])\\p{Lu}\\p{Ll}+${SPACE}+)`, "uy");
const SENTENCE_START_BEFORE = /(?<=^\s*|[.!?]["”’')\]]*\s+)/uy;
const CANONICAL_ROMAN = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
const ROMAN_DIGITS: Readonly<Record<string, number>> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/** Value of a canonical numeral ("IIII" and "IC" are rejected). */
function romanValue(numeral: string): number | undefined {
  if (!CANONICAL_ROMAN.test(numeral)) return undefined;
  let total = 0;
  for (let index = 0; index < numeral.length; index += 1) {
    const value = ROMAN_DIGITS[numeral[index]];
    total += value < (ROMAN_DIGITS[numeral[index + 1]] ?? 0) ? -value : value;
  }
  return total;
}

function capitalizeWords(words: string): string {
  return words.replace(/(^|[ -])([a-z])/g, (_, separator: string, letter: string) => separator + letter.toUpperCase());
}

/**
 * A lone "I" after a keyword is read as the pronoun when the keyword is
 * lowercase ("the part I love") or starts a sentence and a lowercase word
 * follows ("Part I love it."). Regnal numerals skip "I" (pronoun) and "X"
 * ("Malcolm X") and stop at XXXIX.
 */
function isPronounI(text: string, numeral: string, start: number, keyword: RegExpExecArray): boolean {
  if (numeral !== "I") return false;
  const [, word, spaces] = keyword;
  return /^\p{Ll}/u.test(word)
    || (at(SENTENCE_START_BEFORE, text, start - spaces.length - word.length)
      && at(LOWERCASE_WORD_AFTER, text, start + 1));
}

function readRomanNumeral(text: string, numeral: string, start: number): string | undefined {
  const value = romanValue(numeral);
  if (value === undefined) return undefined;
  const keyword = matchAt(KEYWORD_BEFORE, text, start);
  if (keyword) return isPronounI(text, numeral, start, keyword) ? undefined : cardinalToWords(value);
  if (value < 2 || value > 39 || numeral === "X" || !at(NAME_BEFORE, text, start)) return undefined;
  return `the ${capitalizeWords(ordinalToWords(value))}`;
}

function scanRomanNumerals(scan: Scan): void {
  for (const match of scan.text.matchAll(ROMAN_TOKEN)) {
    const start = match.index;
    const end = start + match[0].length;
    const replacement = readRomanNumeral(scan.text, match[0], start);
    if (replacement !== undefined) take(scan, start, end, [{ start, end, replacement, reason: "romanNumerals" }]);
  }
}

// ---------------------------------------------------------------------------

/**
 * English normalizer: returns non-overlapping edits for the enabled rules.
 * `region` (e.g. "GB") selects the numeric date order.
 */
export function normalizeEnglish(text: string, rules: ReadonlySet<Rule>, region?: string): TextEdit[] {
  const scan: Scan = {
    text,
    rules,
    dayFirst: DAY_FIRST_REGIONS.has((region ?? "").toUpperCase()),
    claimed: new Uint8Array(text.length),
    edits: [],
  };
  scanAddresses(scan);
  scanCurrency(scan);
  scanMonthDates(scan);
  scanHeights(scan);
  scanNumbers(scan);
  scanAbbreviations(scan);
  scanRomanNumerals(scan);
  return scan.edits;
}
