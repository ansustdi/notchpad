import { describe, expect, it } from "vitest";
import { byteChar, charByte, decodeText, encodeText, formatOffset, inspect, offsetDigits, parseHexString, parseOffset, toHexString } from "./format";

describe("hex strings", () => {
  it("parses common spellings", () => {
    expect(Array.from(parseHexString("DE AD be ef")!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(Array.from(parseHexString("0x01,0x02")!)).toEqual([1, 2]);
    expect(Array.from(parseHexString("00ff")!)).toEqual([0, 255]);
  });

  it("rejects non-hex and odd digit counts", () => {
    expect(parseHexString("hello")).toBeNull();
    expect(parseHexString("ABC")).toBeNull();
    expect(parseHexString("")).toBeNull();
  });

  it("formats bytes", () => {
    expect(toHexString(new Uint8Array([0, 10, 255]))).toBe("00 0A FF");
  });
});

describe("charsets", () => {
  it("shows unprintable bytes as dots", () => {
    expect(byteChar(0x41, "ascii")).toBe("A");
    expect(byteChar(0x00, "ascii")).toBe(".");
    expect(byteChar(0xe9, "ascii")).toBe(".");
    expect(byteChar(0xe9, "ansi")).toBe("é");
    expect(byteChar(0x80, "ansi")).toBe("€");
    expect(byteChar(0x81, "ansi")).toBe(".");
  });

  it("round-trips text", () => {
    expect(charByte("€", "ansi")).toBe(0x80);
    expect(charByte("€", "ascii")).toBeNull();
    expect(Array.from(encodeText("Aé\n", "ansi"))).toEqual([0x41, 0xe9, 0x0a]);
    expect(Array.from(encodeText("é", "ascii"))).toEqual([0x3f]);
    expect(decodeText(new Uint8Array([0x48, 0x69, 0x00]), "ascii")).toBe("Hi.");
  });
});

describe("offsets", () => {
  it("formats in hex and decimal", () => {
    expect(formatOffset(255, "hex", 8)).toBe("000000FF");
    expect(formatOffset(255, "dec", 5)).toBe("  255");
    expect(offsetDigits(100, "hex")).toBe(8);
    expect(offsetDigits(0x1_0000_0000, "hex")).toBe(9);
  });

  it("parses go-to input", () => {
    expect(parseOffset("1A", "hex", 0)).toBe(26);
    expect(parseOffset("26", "dec", 0)).toBe(26);
    expect(parseOffset("0x1A", "dec", 0)).toBe(26);
    expect(parseOffset("1Ah", "dec", 0)).toBe(26);
    expect(parseOffset("#26", "hex", 0)).toBe(26);
    expect(parseOffset("+10", "hex", 100)).toBe(116);
    expect(parseOffset("-0x10", "dec", 100)).toBe(84);
    expect(parseOffset("zz", "hex", 0)).toBeNull();
  });
});

describe("inspect", () => {
  const get = (rows: ReturnType<typeof inspect>, label: string) => rows.find((r) => r.label === label)?.value;

  it("reads little and big endian values", () => {
    const b = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0]);
    const le = inspect(b, true, "ansi");
    expect(get(le, "UInt16")).toBe("513");
    expect(get(le, "UInt32")).toBe("67305985");
    expect(get(le, "Binary (8 bit)")).toBe("00000001");
    const be = inspect(b, false, "ansi");
    expect(get(be, "UInt16")).toBe("258");
    expect(get(be, "Int24")).toBe("66051");
  });

  it("handles signs, floats, short input and UTF-8", () => {
    expect(get(inspect(new Uint8Array([0xff, 0xff]), true, "ascii"), "Int16")).toBe("-1");
    expect(get(inspect(new Uint8Array([0, 0, 0x80, 0x3f]), true, "ascii"), "Float32")).toBe("1.0");
    expect(get(inspect(new Uint8Array([0xff]), true, "ascii"), "Int32")).toBe("");
    expect(get(inspect(new Uint8Array([0xc3, 0xa9]), true, "ascii"), "UTF-8 char")).toBe("é (U+00E9)");
  });
});
