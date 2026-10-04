import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, sha256Hex, urlDecode } from "./textops";

describe("text transforms", () => {
  it("round-trips UTF-8 through Base64", () => {
    const s = "héllo Привет 👋";
    expect(base64Encode("hi")).toBe("aGk=");
    expect(base64Decode(base64Encode(s))).toBe(s);
    expect(base64Decode("aG\nk=")).toBe("hi");
    expect(() => base64Decode("*")).toThrow(/Base64/);
    expect(() => base64Decode(base64EncodeBytes([0xff, 0xfe]))).toThrow(/UTF-8/);
  });

  it("decodes URLs including '+' as space", () => {
    expect(urlDecode("a%20b+c%C3%A9")).toBe("a b cé");
    expect(() => urlDecode("%E0%A4%A")).toThrow(/Malformed/);
  });

  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

function base64EncodeBytes(bytes: number[]) {
  return btoa(String.fromCharCode(...bytes));
}
