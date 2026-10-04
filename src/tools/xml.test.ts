import { describe, expect, it } from "vitest";
import { checkXml, formatXml, minifyXml, XmlError } from "./xml";

describe("formatXml", () => {
  it("indents nested elements and keeps short text inline", () => {
    const src = '<?xml version="1.0"?><root a="1"><item id="x">hi</item><empty/><e></e><!-- c --><b><c>1</c></b></root>';
    expect(formatXml(src)).toBe(
      [
        '<?xml version="1.0"?>',
        '<root a="1">',
        '  <item id="x">hi</item>',
        "  <empty/>",
        "  <e></e>",
        "  <!-- c -->",
        "  <b>",
        "    <c>1</c>",
        "  </b>",
        "</root>",
      ].join("\n"),
    );
  });

  it("leaves attribute values, CDATA and DOCTYPE subsets untouched", () => {
    const src = '<!DOCTYPE r [<!ENTITY x "a>b">]><r t="a > b" u=\'"q"\'><![CDATA[ <not a tag> ]]></r>';
    const out = formatXml(src);
    expect(out).toContain('<!DOCTYPE r [<!ENTITY x "a>b">]>');
    expect(out).toContain('<r t="a > b" u=\'"q"\'>');
    expect(out).toContain("<![CDATA[ <not a tag> ]]>");
    expect(minifyXml(out)).toBe(src);
  });

  it("minifies whitespace between tags only", () => {
    expect(minifyXml("<a>\n  <b> x y </b>\n  <c/>\n</a>\n")).toBe("<a><b>x y</b><c/></a>");
  });
});

describe("checkXml", () => {
  const err = (src: string) => {
    try {
      checkXml(src);
    } catch (e) {
      return e as XmlError;
    }
    throw new Error("expected an error");
  };

  it("finds mismatched tags with position", () => {
    const e = err("<a>\n  <b>\n  </c>\n</a>");
    expect(e.message).toMatch(/Expected <\/b> but found <\/c>/);
    expect([e.line, e.column]).toEqual([3, 3]);
  });

  it("reports structural problems", () => {
    expect(err("<a>").message).toMatch(/never closed/);
    expect(err("</a>").message).toMatch(/no matching opening/);
    expect(err("<a/><b/>").message).toMatch(/Second root/);
    expect(err("hello <a/>").message).toMatch(/outside the root/);
    expect(err("<a><!-- x </a>").message).toMatch(/Unterminated comment/);
    expect(err("<a b='1'").message).toMatch(/Unterminated tag/);
    expect(err("   ").message).toMatch(/No root/);
  });
});
