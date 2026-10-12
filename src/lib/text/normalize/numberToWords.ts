/**
 * English number verbalization used by the speech normalizer.
 *
 * Conventions (en-US):
 * - Cardinals never insert "and" ("one hundred twenty-three") and hyphenate
 *   21-99 ("forty-two"). Short scale up to the trillions.
 * - Integers with more than 15 digits (>= 10^15) are read digit by digit.
 * - Cardinals ignore leading zeros ("007" -> "seven"); use `digitsToWords`
 *   to read codes digit by digit.
 * - Negative values read "minus". Fractional digits are read one by one after
 *   "point" ("3.14" -> "three point one four", ".5" -> "point five").
 * - Years 1000-9999 are read in pairs ("nineteen eighty-four", "eleven oh
 *   five", "nineteen hundred", "twenty ten"); round thousands and the first
 *   nine years of a millennium are cardinals ("two thousand", "two thousand
 *   five"). Other years are cardinals.
 *
 * Inputs may be numbers or decimal strings; pass strings for values beyond
 * Number.MAX_SAFE_INTEGER so no precision is lost. Invalid input throws a
 * RangeError.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", " thousand", " million", " billion", " trillion"];
const MAX_CARDINAL_DIGITS = 15;
const INTEGER_TEXT = /^(-?)(\d+)$/;
const DECIMAL_TEXT = /^(-?)(\d*)(?:\.(\d+))?$/;
const DIGITS_TEXT = /^\d+$/;
const IRREGULAR_ORDINALS: Readonly<Record<string, string>> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** Words for 1-999. */
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const words: string[] = [];
  if (hundreds > 0) words.push(`${ONES[hundreds]} hundred`);
  if (rest >= 20) {
    const unit = rest % 10;
    words.push(unit > 0 ? `${TENS[Math.floor(rest / 10)]}-${ONES[unit]}` : TENS[rest / 10]);
  } else if (rest > 0) {
    words.push(ONES[rest]);
  }
  return words.join(" ");
}

function integerWords(digits: string): string {
  const significant = digits.replace(/^0+(?=\d)/, "");
  if (significant.length > MAX_CARDINAL_DIGITS) return digitsToWords(significant);
  const groupCount = Math.ceil(significant.length / 3);
  const words: string[] = [];
  for (let group = 0; group < groupCount; group += 1) {
    const scale = groupCount - 1 - group;
    const end = significant.length - scale * 3;
    const value = Number(significant.slice(Math.max(0, end - 3), end));
    if (value > 0) words.push(`${belowThousand(value)}${SCALES[scale]}`);
  }
  return words.length > 0 ? words.join(" ") : "zero";
}

/** Reads every digit on its own: "4096" -> "four zero nine six". */
export function digitsToWords(digits: string): string {
  if (!DIGITS_TEXT.test(digits)) throw new RangeError(`Expected digits, got "${digits}".`);
  return Array.from(digits, (digit) => ONES[Number(digit)]).join(" ");
}

/** Integer cardinal: 123 -> "one hundred twenty-three", "-5" -> "minus five". */
export function cardinalToWords(value: number | string): string {
  const match = INTEGER_TEXT.exec(String(value));
  if (!match) throw new RangeError(`Expected an integer, got "${String(value)}".`);
  const words = integerWords(match[2]);
  return match[1] ? `minus ${words}` : words;
}

/** Integer ordinal: 21 -> "twenty-first", 100 -> "one hundredth". */
export function ordinalToWords(value: number | string): string {
  return cardinalToWords(value).replace(
    /[a-z]+$/,
    (word) => IRREGULAR_ORDINALS[word] ?? (word.endsWith("y") ? `${word.slice(0, -1)}ieth` : `${word}th`),
  );
}

/** Decimal: "3.14" -> "three point one four", ".5" -> "point five". */
export function decimalToWords(value: number | string): string {
  const match = DECIMAL_TEXT.exec(String(value));
  if (!match || (match[2] === "" && match[3] === undefined)) {
    throw new RangeError(`Expected a decimal number, got "${String(value)}".`);
  }
  const [, sign, whole, fraction] = match;
  const parts: string[] = [];
  if (whole) parts.push(integerWords(whole));
  if (fraction !== undefined) parts.push(`point ${digitsToWords(fraction)}`);
  const words = parts.join(" ");
  return sign ? `minus ${words}` : words;
}

/** Year read in pairs: 1984 -> "nineteen eighty-four", 2005 -> "two thousand five". */
export function yearToWords(year: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return cardinalToWords(year);
  const century = Math.floor(year / 100);
  const rest = year % 100;
  if (century % 10 === 0 && rest < 10) return integerWords(String(year));
  if (rest === 0) return `${belowThousand(century)} hundred`;
  if (rest < 10) return `${belowThousand(century)} oh ${ONES[rest]}`;
  return `${belowThousand(century)} ${belowThousand(rest)}`;
}

/**
 * Decade or plural tens: 1990 -> "nineteen nineties", 2000 -> "two thousands",
 * 90 -> "nineties". Values from 1000 up are read like years.
 */
export function decadeToWords(decade: number): string {
  if (!(decade > 0 && decade % 10 === 0)) {
    throw new RangeError(`Expected a positive multiple of ten, got ${decade}.`);
  }
  const words = decade >= 1000 ? yearToWords(decade) : cardinalToWords(decade);
  return words.endsWith("y") ? `${words.slice(0, -1)}ies` : `${words}s`;
}
