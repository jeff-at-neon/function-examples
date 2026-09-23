import { describe, expect, it } from "vitest";
import {
  assertIterationBudget,
  parseToolArguments,
  resolveTool,
  ToolArgumentsError,
  ToolIterationLimit,
  withinIterationBudget,
  type ToolDefinition,
} from "../src/tool-loop.js";

describe("iteration budget", () => {
  it("allows iterations below the ceiling", () => {
    expect(withinIterationBudget(0, 6)).toBe(true);
    expect(withinIterationBudget(5, 6)).toBe(true);
  });

  it("stops at the ceiling", () => {
    expect(withinIterationBudget(6, 6)).toBe(false);
  });

  it("throws once the ceiling is reached", () => {
    expect(() => assertIterationBudget(6, 6)).toThrow(ToolIterationLimit);
    expect(() => assertIterationBudget(2, 6)).not.toThrow();
  });
});

describe("parseToolArguments", () => {
  it("parses a JSON arguments object", () => {
    expect(parseToolArguments('{"q":"shoes"}')).toEqual({ q: "shoes" });
  });

  it("treats an empty string as no arguments", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
  });

  it("throws a typed error on malformed JSON", () => {
    expect(() => parseToolArguments("{not json")).toThrow(ToolArgumentsError);
  });
});

describe("resolveTool", () => {
  const tools: ToolDefinition[] = [
    { name: "search", description: "", parameters: {}, handler: async () => null },
  ];

  it("finds a tool by name", () => {
    expect(resolveTool(tools, "search").name).toBe("search");
  });

  it("throws for an unknown tool", () => {
    expect(() => resolveTool(tools, "delete_everything")).toThrow(ToolArgumentsError);
  });
});
