import { describe, expect, it, vi } from "vitest";

// smartQuery is pure; keep Monaco (DOM-only) out of the test.
vi.mock("./monaco", () => ({ monaco: {} }));
vi.mock("./store/settings", () => ({ useSettings: {} }));
vi.mock("./store/ui", () => ({ useUi: {} }));

const { smartQuery } = await import("./smartHighlight");

describe("smartQuery", () => {
  it("uses whole-word matching only for word selections", () => {
    expect(smartQuery("15550102", true)).toEqual({ text: "15550102", wholeWord: true });
    expect(smartQuery("O:15550102", true)).toEqual({ text: "O:15550102", wholeWord: false });
    expect(smartQuery("Привет", true)).toEqual({ text: "Привет", wholeWord: true });
    expect(smartQuery("batch task", true)).toEqual({ text: "batch task", wholeWord: false });
    expect(smartQuery("abc", false)).toEqual({ text: "abc", wholeWord: false });
  });

  it("ignores empty, whitespace, multi-line and very long selections", () => {
    expect(smartQuery("", true)).toBeNull();
    expect(smartQuery("   ", true)).toBeNull();
    expect(smartQuery("a\nb", true)).toBeNull();
    expect(smartQuery("x".repeat(300), true)).toBeNull();
  });
});
