import { describe, expect, it } from "vitest";
import {
  cardinalToWords,
  decadeToWords,
  decimalToWords,
  digitsToWords,
  ordinalToWords,
  yearToWords,
} from "./numberToWords";

describe("cardinalToWords", () => {
  it.each<[number | string, string]>([
    [0, "zero"],
    [7, "seven"],
    [13, "thirteen"],
    [20, "twenty"],
    [21, "twenty-one"],
    [99, "ninety-nine"],
    [100, "one hundred"],
    [101, "one hundred one"],
    [123, "one hundred twenty-three"],
    [1000, "one thousand"],
    [1001, "one thousand one"],
    [2024, "two thousand twenty-four"],
    [1_000_000, "one million"],
    [1_234_567, "one million two hundred thirty-four thousand five hundred sixty-seven"],
    [3_000_000_001, "three billion one"],
    ["999999999999999", "nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine"],
    ["1000000000000000", "one zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero"],
    ["007", "seven"],
    ["000", "zero"],
    [-5, "minus five"],
    ["-120", "minus one hundred twenty"],
  ])("reads %s", (value, expected) => {
    expect(cardinalToWords(value)).toBe(expected);
  });

  it.each([1.5, Number.NaN, 1e21, "1,000", "", "12a"])("rejects %s", (value) => {
    expect(() => cardinalToWords(value)).toThrow(RangeError);
  });
});

describe("ordinalToWords", () => {
  it.each<[number | string, string]>([
    [0, "zeroth"],
    [1, "first"],
    [2, "second"],
    [3, "third"],
    [4, "fourth"],
    [5, "fifth"],
    [8, "eighth"],
    [9, "ninth"],
    [11, "eleventh"],
    [12, "twelfth"],
    [20, "twentieth"],
    [21, "twenty-first"],
    [100, "one hundredth"],
    [101, "one hundred first"],
    ["1000", "one thousandth"],
  ])("reads %s", (value, expected) => {
    expect(ordinalToWords(value)).toBe(expected);
  });
});

describe("decimalToWords", () => {
  it.each<[number | string, string]>([
    ["3.14", "three point one four"],
    [0.5, "zero point five"],
    [".5", "point five"],
    ["-.5", "minus point five"],
    [-2.25, "minus two point two five"],
    ["1234.56", "one thousand two hundred thirty-four point five six"],
    ["2.0", "two point zero"],
    [12, "twelve"],
  ])("reads %s", (value, expected) => {
    expect(decimalToWords(value)).toBe(expected);
  });

  it.each(["", "-", ".", "1.2.3", "abc", 1e-7])("rejects %s", (value) => {
    expect(() => decimalToWords(value)).toThrow(RangeError);
  });
});

describe("digitsToWords", () => {
  it("reads every digit", () => {
    expect(digitsToWords("4096")).toBe("four zero nine six");
  });

  it("rejects non-digits", () => {
    expect(() => digitsToWords("12a")).toThrow(RangeError);
  });
});

describe("yearToWords", () => {
  it.each<[number, string]>([
    [1984, "nineteen eighty-four"],
    [1900, "nineteen hundred"],
    [1105, "eleven oh five"],
    [1000, "one thousand"],
    [1005, "one thousand five"],
    [2000, "two thousand"],
    [2005, "two thousand five"],
    [2010, "twenty ten"],
    [2099, "twenty ninety-nine"],
    [2100, "twenty-one hundred"],
    [999, "nine hundred ninety-nine"],
    [10000, "ten thousand"],
    [-44, "minus forty-four"],
  ])("reads %s", (year, expected) => {
    expect(yearToWords(year)).toBe(expected);
  });

  it("rejects fractional years", () => {
    expect(() => yearToWords(1500.5)).toThrow(RangeError);
  });
});

describe("decadeToWords", () => {
  it.each<[number, string]>([
    [1990, "nineteen nineties"],
    [1900, "nineteen hundreds"],
    [2000, "two thousands"],
    [2010, "twenty tens"],
    [90, "nineties"],
    [10, "tens"],
    [500, "five hundreds"],
  ])("reads %s", (decade, expected) => {
    expect(decadeToWords(decade)).toBe(expected);
  });

  it.each([0, 15, -10, Number.NaN])("rejects %s", (decade) => {
    expect(() => decadeToWords(decade)).toThrow(RangeError);
  });
});
