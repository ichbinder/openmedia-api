import { describe, expect, it } from "vitest";
import { parseRatingInput, parseTasteInput, traktVerdict } from "./taste.js";

const person = (over: Record<string, unknown> = {}) => ({
  name: "A",
  limits: [],
  limitsText: "",
  ...over,
});
const taste = (over: Record<string, unknown> = {}, ids: string[] = []) =>
  parseTasteInput({ persons: [person()], genres: [], likesText: "", ...over }, ids);

describe("traktVerdict", () => {
  it.each([
    [10, "up"],
    [8, "up"],
    [7, "meh"],
    [5, "meh"],
    [4, "down"],
    [1, "down"],
    [0, null],
    [11, null],
    [7.5, null],
  ])("%s -> %s", (rating, expected) => {
    expect(traktVerdict(rating)).toBe(expected);
  });
});

describe("parseRatingInput", () => {
  it("applies defaults", () => {
    expect(parseRatingInput({ verdict: "up" }, [])).toEqual({
      verdict: "up",
      tags: [],
      forWhom: null,
      source: "app",
    });
  });

  it("dedupes tags and keeps forWhom and source", () => {
    expect(
      parseRatingInput(
        { verdict: "meh", tags: ["zaeh", "zaeh", "plump"], forWhom: "p1", source: "quiz" },
        ["p1"],
      ),
    ).toEqual({ verdict: "meh", tags: ["zaeh", "plump"], forWhom: "p1", source: "quiz" });
  });

  it.each([
    [{ verdict: "great" }, []],
    [{ verdict: null }, []],
    [{ verdict: "up", tags: ["toll"] }, []],
    [{ verdict: "up", tags: "spannend" }, []],
    [{ verdict: "up", forWhom: "x" }, []],
    [{ verdict: "up", forWhom: "x" }, ["p1"]],
    [{ verdict: "up", source: "trakt" }, []],
    ["nope", []],
  ])("rejects %j", (body, ids) => {
    expect(parseRatingInput(body, ids)).toHaveProperty("error");
  });
});

describe("parseTasteInput", () => {
  it("trims names", () => {
    expect(
      parseTasteInput(
        {
          persons: [{ name: "  Anna ", limits: ["horror"], limitsText: "" }],
          genres: ["krimi"],
          likesText: "gut erzählt",
        },
        [],
      ),
    ).toEqual({
      persons: [{ name: "Anna", limits: ["horror"], limitsText: "" }],
      genres: ["krimi"],
      likesText: "gut erzählt",
    });
  });

  it("keeps known person ids", () => {
    expect(taste({ persons: [person({ id: "p1" })] }, ["p1"])).toHaveProperty("persons.0.id", "p1");
  });

  it.each([
    ["no persons", { persons: [] }],
    ["7 persons", { persons: Array.from({ length: 7 }, () => person()) }],
    ["blank name", { persons: [person({ name: "   " })] }],
    ["long name", { persons: [person({ name: "x".repeat(41) })] }],
    ["unknown limit", { persons: [person({ limits: ["blut"] })] }],
    ["unknown genre", { genres: ["western"] }],
    ["long likesText", { likesText: "x".repeat(2001) }],
    ["long limitsText", { persons: [person({ limitsText: "x".repeat(501) })] }],
    ["foreign id", { persons: [person({ id: "fremd" })] }],
    ["duplicate id", { persons: [person({ id: "p1" }), person({ id: "p1", name: "B" })] }],
  ])("rejects %s", (_, over) => {
    expect(taste(over, ["p1"])).toHaveProperty("error");
  });
});
