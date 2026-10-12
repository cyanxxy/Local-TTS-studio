import { describe, expect, it } from "vitest";
import { applyTextEdits, type TextRewrite } from "../textEdits";
import { normalizeEnglish } from "./en";
import type { SpeechNormalizationRule } from "./types";

const ALL_RULES: readonly SpeechNormalizationRule[] = [
  "numbers", "ordinals", "decimals", "years", "dates", "times", "currency",
  "percentages", "units", "abbreviations", "urls", "emails", "romanNumerals",
];

function rewrite(
  text: string,
  region?: string,
  rules: readonly SpeechNormalizationRule[] = ALL_RULES,
): TextRewrite {
  return applyTextEdits(text, normalizeEnglish(text, new Set(rules), region));
}

const normalize = (text: string, region?: string) => rewrite(text, region).text;

type Fixture = readonly [input: string, expected: string];

const FIXTURES: Record<string, readonly Fixture[]> = {
  numbers: [
    ["I have 7 cats.", "I have seven cats."],
    ["1,234,567 people", "one million two hundred thirty-four thousand five hundred sixty-seven people"],
    ["Agent 007", "Agent zero zero seven"],
    ["Population: 12345678901234567.", "Population: one two three four five six seven eight nine zero one two three four five six seven."],
    ["It fell to -5 today.", "It fell to minus five today."],
    ["Lows of −7 (or -2).", "Lows of minus seven (or minus two)."],
    ["Compute 5 -3 now.", "Compute five minus three now."],
    ["Wait 3-5 days.", "Wait three to five days."],
    ["Pages 3–5 and 0-5.", "Pages three to five and zero to five."],
    ["Read 10-20 of them.", "Read ten to twenty of them."],
    ["a 19-year-old", "a nineteen-year-old"],
    ["Steps 1 and 2.", "Steps one and two."],
  ],
  years: [
    ["In 1990 we left.", "In nineteen ninety we left."],
    ["since 1999 they", "since nineteen ninety-nine they"],
    ["the 2024 race", "the twenty twenty-four race"],
    ["c. 1500 or so", "c. fifteen hundred or so"],
    ["Born 1984.", "Born nineteen eighty-four."],
    ["Released (2005) by Acme", "Released (two thousand five) by Acme"],
    ["Copyright 2010 Acme", "Copyright twenty ten Acme"],
    ["It was built in 1105.", "It was built in eleven oh five."],
    ["Founded 1215 AD.", "Founded twelve fifteen AD."],
    ["2024 apples", "two thousand twenty-four apples"],
    ["page 1999 then", "page one thousand nine hundred ninety-nine then"],
    ["Room 1234.", "Room one thousand two hundred thirty-four."],
    ["1,500 people", "one thousand five hundred people"],
    ["In 1066 it fell.", "In one thousand sixty-six it fell."],
    ["The 1990s and '90s and ’80s.", "The nineteen nineties and nineties and eighties."],
    ["In the 1990's and 1900s and 2000s and 2010s", "In the nineteen nineties and nineteen hundreds and two thousands and twenty tens"],
    ["She is in her 20s.", "She is in her twenties."],
    ["rock'80s", "rock'eighties"],
    ["From 1990-1995 only.", "From nineteen ninety to nineteen ninety-five only."],
  ],
  ordinals: [
    ["1st 2nd 3rd 4th", "first second third fourth"],
    ["11th 12th 13th 21st 22nd 33rd 44th", "eleventh twelfth thirteenth twenty-first twenty-second thirty-third forty-fourth"],
    ["101st 111th 112th 113th", "one hundred first one hundred eleventh one hundred twelfth one hundred thirteenth"],
    ["the 1,000th visitor", "the one thousandth visitor"],
    ["the 5TH time", "the fifth time"],
  ],
  decimals: [
    ["Pi is 3.14.", "Pi is three point one four."],
    ["0.5 and .5", "zero point five and point five"],
    ["1,234.56 total", "one thousand two hundred thirty-four point five six total"],
    ["Version 2.0 shipped.", "Version two point zero shipped."],
    ["It dropped to -0.25.", "It dropped to minus zero point two five."],
  ],
  percentages: [
    ["50% off", "fifty percent off"],
    ["12.5 % growth", "twelve point five percent growth"],
    ["down -3%", "down minus three percent"],
    ["10-20% more", "ten to twenty percent more"],
  ],
  currency: [
    ["$3.50", "three dollars and fifty cents"],
    ["£2.05", "two pounds and five pence"],
    ["€1 and €2", "one euro and two euros"],
    ["¥500 or ¥3.50", "five hundred yen or three point five zero yen"],
    ["₹10.25", "ten rupees and twenty-five paise"],
    ["USD 100 or 100 EUR", "one hundred dollars or one hundred euros"],
    ["CAD 5 and 5 AUD and INR 1", "five Canadian dollars and five Australian dollars and one rupee"],
    ["GBP 1.50 and GBP 0.01", "one pound and fifty pence and one penny"],
    ["$1.5M, $2B, $3k, $5m", "one point five million dollars, two billion dollars, three thousand dollars, five million dollars"],
    ["$4 million and $5 trillion and 3bn EUR", "four million dollars and five trillion dollars and three billion euros"],
    ["$0.50 and $0.00 and $1.01", "fifty cents and zero dollars and one dollar and one cent"],
    ["$2.00 and $1,000 and $1", "two dollars and one thousand dollars and one dollar"],
    ["$1.505 and $1.5", "one point five zero five dollars and one point five dollars"],
  ],
  units: [
    ["1.5 km", "one point five kilometers"],
    ["1 km, 5km, 10 kg, 3 lbs, 1 lb", "one kilometer, five kilometers, ten kilograms, three pounds, one pound"],
    ["20°C, 98.6 °F, 1°, 45° angle", "twenty degrees Celsius, ninety-eight point six degrees Fahrenheit, one degree, forty-five degrees angle"],
    ["100 mph, 60 km/h, 50 kph", "one hundred miles per hour, sixty kilometers per hour, fifty kilometers per hour"],
    ["5m and 45s and 5ms", "five meters and forty-five seconds and five milliseconds"],
    // Glued "s" after 10, 20, ... 90 reads as a decade ("in her 20s"), not seconds.
    ["10s", "tens"],
    ["5 min, 2 h, 3 hr, 6 ft, 1 ft, 2 mi, 4 oz", "five minutes, two hours, three hours, six feet, one foot, two miles, four ounces"],
    ["4GB, 512 kB, 2 TB, 2.4 GHz, 60 Hz", "four gigabytes, five hundred twelve kilobytes, two terabytes, two point four gigahertz, sixty hertz"],
    ["100 W, 2 kW, 5 V, 5000 mAh", "one hundred watts, two kilowatts, five volts, five thousand milliamp hours"],
    ["2 L, 500 mL, 5 ml, 3 mg, 5 g, 2 cm, 4 mm, 3 m tall", "two liters, five hundred milliliters, five milliliters, three milligrams, five grams, two centimeters, four millimeters, three m tall"],
    ["3-5 km", "three to five kilometers"],
    ["-5°C and 1.0 km", "minus five degrees Celsius and one point zero kilometers"],
  ],
  times: [
    ["At 10:30.", "At ten thirty."],
    ["10:30am, 10:30 a.m., 10:30 AM", "ten thirty AM, ten thirty AM, ten thirty AM"],
    ["7 PM, 7pm, 7 p.m., 12 am", "seven PM, seven PM, seven PM, twelve AM"],
    ["Meet at 7 p.m. Then go.", "Meet at seven PM. Then go."],
    ["Leave at 6 a.m.", "Leave at six AM."],
    ["23:15 and 9:05 and 0:05", "twenty-three fifteen and nine oh five and zero oh five"],
    ["12:00, 1:00 PM, 14:00, 00:00", "twelve o'clock, one PM, fourteen hundred, zero hundred"],
    ["10:30:15 and 10:30:01 and 10:30:00", "ten thirty and fifteen seconds and ten thirty and one second and ten thirty"],
    ["10:30:15 pm", "ten thirty and fifteen seconds PM"],
    ["John 3:16 says", "John three sixteen says"],
  ],
  dates: [
    ["On 2024-03-15.", "On March fifteenth, twenty twenty-four."],
    ["3/15/2024 and 15/3/2024", "March fifteenth, twenty twenty-four and March fifteenth, twenty twenty-four"],
    ["2/29/2024 and 2/29/2000", "February twenty-ninth, twenty twenty-four and February twenty-ninth, two thousand"],
    ["March 3, 2024", "March third, twenty twenty-four"],
    ["3 March 2024", "the third of March twenty twenty-four"],
    ["1 March and 2nd of May, 2024", "the first of March and the second of May, twenty twenty-four"],
    ["March 3rd, March 2nd, March 1st, March 11th, March 22nd, March 30th", "March third, March second, March first, March eleventh, March twenty-second, March thirtieth"],
    ["Jan. 5 and Feb 29 and Sept. 3", "January fifth and February twenty-ninth and September third"],
    ["Feb. 5, 2024 and 5 Sept. 2023", "February fifth, twenty twenty-four and the fifth of September twenty twenty-three"],
    ["Meet 3 Jan. Then go. Meet 3 Jan. and go.", "Meet the third of January. Then go. Meet the third of January and go."],
    ["May 2024 and Dec. 2023", "May twenty twenty-four and December twenty twenty-three"],
    ["on the 21st of May", "on the twenty-first of May"],
    ["on The 21st of May 2024", "on The twenty-first of May twenty twenty-four"],
    ["the 5th May and 21st May", "the fifth of May and the twenty-first of May"],
    ["May 21st and the 21 May", "May twenty-first and the twenty-first of May"],
    ["February 30 and 31 June", "February thirty and thirty-one June"],
  ],
  abbreviations: [
    ["Dr. Smith and Mr. Jones met Mrs. Brown and Ms. Lee.", "Doctor Smith and Mister Jones met Missus Brown and Miz Lee."],
    ["Prof. Xu climbed Mt. Fuji.", "Professor Xu climbed Mount Fuji."],
    ["St. Paul's and St. James", "Saint Paul's and Saint James"],
    ["on Main St., then", "on Main Street, then"],
    ["We live on Main St.", "We live on Main Street."],
    ["42 Main St. Then we left.", "forty-two Main Street. Then we left."],
    ["Apples, pears, etc. Then we left.", "Apples, pears, et cetera. Then we left."],
    ["Apples, etc., were fine.", "Apples, et cetera, were fine."],
    ["Use e.g. this, i.e. that, approx. 5 vs. 6.", "Use for example this, that is that, approximately five versus six."],
    ["No. 5 and no. 7", "Number five and number seven"],
    ["Acme Inc. announced. Acme Ltd. too. Acme Co. and Acme Corp. grew.", "Acme Incorporated announced. Acme Limited too. Acme Company and Acme Corporation grew."],
    ["John Smith Jr. and Sr. arrived at the Dept. on Fifth Ave.", "John Smith Junior and Senior arrived at the Department on Fifth Avenue."],
  ],
  urls: [
    ["Visit https://example.com/path now.", "Visit example dot com slash path now."],
    ["Go to www.example.com.", "Go to w w w dot example dot com."],
    ["See example.org, or example.co.uk!", "See example dot org, or example dot co dot uk!"],
    ["(see https://x.com/a).", "(see x dot com slash a)."],
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "en dot wikipedia dot org"],
    ["(see https://en.wikipedia.org/wiki/Foo_(bar))", "(see en dot wikipedia dot org)"],
    ["https://a.b.com/x_y~z/a-b.", "a dot b dot com slash x underscore y tilde z slash a dash b."],
    ["https://example.com/a/b/c/d", "example dot com"],
    ["https://example.com/a%20b", "example dot com"],
    ["https://example.com/very-long-segment-name-here?q=1#top", "example dot com"],
    ["HTTP://example.com:8080/v2", "example dot com colon eight zero eight zero slash v2"],
    ["site123.io/2024", "site123 dot io slash two zero two four"],
    ["(example.com)", "(example dot com)"],
  ],
  emails: [
    ["Email jane.doe@example.com now.", "Email jane dot doe at example dot com now."],
    ["user_name+tag@mail-server.co.uk", "user underscore name plus tag at mail dash server dot co dot uk"],
    ["Write to a-b@c.io.", "Write to a dash b at c dot io."],
    ["Mail 100%off@x99.com", "Mail one zero zero percent off at x99 dot com"],
  ],
  romanNumerals: [
    ["Chapter IV: the end.", "Chapter four: the end."],
    ["Book I, Act I. Scene II.", "Book one, Act one. Scene two."],
    ["In Part I of it. Part I: Origins.", "In Part one of it. Part one: Origins."],
    ["CHAPTER XII and chapter IX and Vol. III", "CHAPTER twelve and chapter nine and Vol. three"],
    ["World War II", "World War two"],
    ["Henry VIII and Elizabeth II and Louis XIV.", "Henry the Eighth and Elizabeth the Second and Louis the Fourteenth."],
    ["Henry V and Louis XXXIX", "Henry the Fifth and Louis the Thirty-Ninth"],
    ["Henry VIII's crown", "Henry the Eighth's crown"],
  ],
};

/** Must come out unchanged. */
const UNCHANGED: readonly string[] = [
  "A4 paper, COVID-19, mp3, B2B, x86, 4K, 3D, 1080p",
  "v1.2.3 and 3.10.2 and 192.168.0.1 and 978-3-16-148410-0",
  "0x1F and 0xFF",
  "Call 555-1234 or (555) 123-4567 or 555.123.4567 or 1-800-555-1234.",
  "Call +1 555 123 4567 or +44 20 7946 0958.",
  "24/7 and 3/4 and 1,23 and 3:1",
  "1th and 3th and March 2th",
  "x-5 and 5−3 and 2024-03 and 20-10 and 3-3 and 07-12",
  "555-1234 and 12345-6789 and 1234-5678",
  "2024-02-30 and 2024-13-01 and 2024-03-15T10:00 and 3/15/2024x and 13/13/2024 and 0/5/2024",
  "2/29/2023 and 2/29/1900",
  "13:00 pm and 10:75 and 10:30:75 and 24:00 and 10:30x",
  "$5,00 and $1.2.3",
  "5.x and 3.14abc and v.5 and .5.6 and 5,a",
  "Mr Smith, Dr. who, dr. Smith, No. more, No.5, St., (St.)",
  "MIX, CIVIL, DI, The IIII, Chapter IIII, the IV, Xavier XL, George I, Pope Pius X, Louis XL",
  "Then I went. Part I love it. the part I love. chapter iv",
  "http://localhost:3000/x",
  "The café2024 and naïve5 stay.",
  "Plain prose without any numbers.",
  "",
];

/** [input, expected, region] */
const REGIONAL: readonly (readonly [string, string, string])[] = [
  ["On 3/4/2024.", "On the third of April, twenty twenty-four.", "GB"],
  ["On the 3/4/2024.", "On the third of April, twenty twenty-four.", "GB"],
  ["On 3/4/2024.", "On the third of April, twenty twenty-four.", "au"],
  ["On 3/4/2024.", "On March fourth, twenty twenty-four.", "US"],
  ["4/13/2024 and 13/4/2024", "the thirteenth of April, twenty twenty-four and the thirteenth of April, twenty twenty-four", "IE"],
  ["2024-03-15", "the fifteenth of March, twenty twenty-four", "NZ"],
  ["31/4/2024", "31/4/2024", "ZA"],
];

const ALL_INPUTS = [
  ...Object.values(FIXTURES).flat().map(([input]) => input),
  ...UNCHANGED,
  ...REGIONAL.map(([input]) => input),
];

describe("normalizeEnglish", () => {
  describe.each(Object.entries(FIXTURES))("%s", (_category, fixtures) => {
    it.each(fixtures)("%j", (input, expected) => {
      expect(normalize(input)).toBe(expected);
    });
  });

  it.each(UNCHANGED)("leaves %j unchanged", (input) => {
    expect(rewrite(input).edits).toEqual([]);
  });

  it.each(REGIONAL)("reads %j for region %s", (input, expected, region) => {
    expect(normalize(input, region)).toBe(expected);
  });

  it("labels each edit with the rule that produced it", () => {
    const reasons = (text: string) => rewrite(text).edits.map((edit) => edit.reason);
    expect(reasons("Jan. 5, 2024 and 7")).toEqual(["abbreviations", "dates", "dates", "numbers"]);
    expect(reasons("3rd 1990s 2.5 10% $1 5 km 7pm")).toEqual(
      ["ordinals", "years", "decimals", "percentages", "currency", "units", "times"],
    );
    expect(reasons("Dr. Who www.x.com a@b.io Henry II")).toEqual(
      ["abbreviations", "urls", "emails", "romanNumerals"],
    );
  });

  it("leaves a disabled rule's matches verbatim instead of reading them generically", () => {
    expect(rewrite("At 10:30 on 2024-03-15, 5 km for $3 and 7.", undefined, ["numbers"]).text)
      .toBe("At 10:30 on 2024-03-15, 5 km for $3 and seven.");
    expect(rewrite("At 10:30 on 2024-03-15, 5 km for $3.", undefined, ["times"]).text)
      .toBe("At ten thirty on 2024-03-15, 5 km for $3.");
    expect(rewrite("In 1990 and Jan. 5 visit x.com/2024", undefined, ["numbers", "abbreviations"]).text)
      .toBe("In 1990 and January 5 visit x.com/2024");
    expect(rewrite("Chapter IV", undefined, []).text).toBe("Chapter IV");
  });

  it("is idempotent over every fixture", () => {
    for (const input of ALL_INPUTS) {
      const once = normalize(input);
      expect(normalize(once), input).toBe(once);
    }
  });

  it("maps every edit back to its source span", () => {
    for (const input of ALL_INPUTS) {
      const result = rewrite(input);
      for (const edit of result.edits) {
        expect(result.toSourceRange({ start: edit.outputStart, end: edit.outputEnd }), input)
          .toEqual({ start: edit.start, end: edit.end });
        expect(result.text.slice(edit.outputStart, edit.outputEnd)).toBe(edit.replacement);
      }
      let previous = 0;
      for (let offset = 0; offset <= result.text.length; offset += 1) {
        const source = result.toSourceOffset(offset);
        expect(source, input).toBeGreaterThanOrEqual(previous);
        previous = source;
      }
    }
  });
});
