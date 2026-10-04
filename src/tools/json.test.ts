import { describe, expect, it } from "vitest";
import { formatJson, JsonError, minifyJson, parseJson } from "./json";

describe("formatJson", () => {
  it("pretty prints with the given indent", () => {
    expect(formatJson('{"a":1,"b":[true,null,{}],"c":{}}', "  ")).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    {}\n  ],\n  "c": {}\n}',
    );
    expect(formatJson("[1,2]", "\t")).toBe("[\n\t1,\n\t2\n]");
  });

  it("keeps big numbers and string escapes byte-exact", () => {
    const src = '{"big":12345678901234567890,"f":1.50e+10,"s":"\\u00e9\\n\\/"}';
    expect(minifyJson(formatJson(src))).toBe(src);
    expect(formatJson(src)).toContain("12345678901234567890");
  });

  it("sorts keys recursively when asked", () => {
    expect(minifyJson(formatJson('{"b":{"z":1,"a":2},"a":[{"y":1,"x":2}]}', " ", true))).toBe(
      '{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}',
    );
  });

  it("minifies and tolerates a BOM and surrounding whitespace", () => {
    expect(minifyJson('\uFEFF  {\n "a" : [ 1 , 2 ]\n}  \n')).toBe('{"a":[1,2]}');
  });
});

describe("parseJson errors", () => {
  const err = (src: string) => {
    try {
      parseJson(src);
    } catch (e) {
      return e as JsonError;
    }
    throw new Error("expected an error");
  };

  it("reports line and column", () => {
    const e = err('{\n  "a": 1,\n  "b" 2\n}');
    expect(e).toBeInstanceOf(JsonError);
    expect([e.line, e.column]).toEqual([3, 7]);
    expect(e.message).toMatch(/Expected ':'/);
  });

  it("rejects common mistakes", () => {
    expect(err('{"a":1,}').message).toMatch(/Trailing comma/);
    expect(err("[1,]").message).toMatch(/Trailing comma/);
    expect(err("{a:1}").message).toMatch(/double quotes/);
    expect(err('"abc').message).toMatch(/Unterminated/);
    expect(err('"a\tb"').message).toMatch(/Control character/);
    expect(err("01").message).toMatch(/after the end/);
    expect(err("[1] [2]").message).toMatch(/after the end/);
    expect(err('"\\x"').message).toMatch(/Invalid escape/);
    expect(err("").message).toMatch(/end of input/);
  });
});
