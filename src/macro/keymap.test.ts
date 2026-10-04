import { describe, expect, it } from "vitest";
import { KeyInfo, MacroStep, mapKey, pushStep } from "./keymap";

const k = (key: string, mods: Partial<Omit<KeyInfo, "key">> = {}): KeyInfo => ({
  key,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe("mapKey (Windows / Linux)", () => {
  const m = (info: KeyInfo) => mapKey(info, false);
  it("types printable keys, including AltGr characters", () => {
    expect(m(k("a"))).toEqual({ type: "text", text: "a" });
    expect(m(k("A", { shift: true }))).toEqual({ type: "text", text: "A" });
    expect(m(k("@", { ctrl: true, alt: true }))).toEqual({ type: "text", text: "@" });
    expect(m(k("Enter"))).toEqual({ type: "text", text: "\n" });
  });
  it("maps navigation and editing keys", () => {
    expect(m(k("ArrowLeft", { ctrl: true, shift: true }))).toEqual({ type: "cmd", id: "cursorWordLeftSelect" });
    expect(m(k("ArrowRight", { ctrl: true }))).toEqual({ type: "cmd", id: "cursorWordEndRight" });
    expect(m(k("End", { ctrl: true }))).toEqual({ type: "cmd", id: "cursorBottom" });
    expect(m(k("Home", { shift: true }))).toEqual({ type: "cmd", id: "cursorHomeSelect" });
    expect(m(k("ArrowDown", { alt: true }))).toEqual({ type: "cmd", id: "editor.action.moveLinesDownAction" });
    expect(m(k("ArrowUp", { alt: true, shift: true }))).toEqual({ type: "cmd", id: "editor.action.copyLinesUpAction" });
    expect(m(k("Backspace", { ctrl: true }))).toEqual({ type: "cmd", id: "deleteWordLeft" });
    expect(m(k("Tab", { shift: true }))).toEqual({ type: "cmd", id: "outdent" });
    expect(m(k("d", { ctrl: true }))).toEqual({ type: "cmd", id: "editor.action.addSelectionToNextFindMatch" });
  });
  it("classifies clipboard keys and unknown shortcuts", () => {
    expect(m(k("c", { ctrl: true }))).toBe("ignore");
    expect(m(k("v", { ctrl: true }))).toBe("paste");
    expect(m(k("x", { ctrl: true }))).toEqual({ type: "cut" });
    expect(m(k("Shift", { shift: true }))).toBe("ignore");
    expect(m(k("q", { ctrl: true }))).toBeNull();
  });
});

describe("mapKey (macOS)", () => {
  const m = (info: KeyInfo) => mapKey(info, true);
  it("uses Option for words and Cmd for line / document ends", () => {
    expect(m(k("ArrowLeft", { alt: true }))).toEqual({ type: "cmd", id: "cursorWordLeft" });
    expect(m(k("ArrowRight", { meta: true, shift: true }))).toEqual({ type: "cmd", id: "cursorEndSelect" });
    expect(m(k("ArrowUp", { meta: true }))).toEqual({ type: "cmd", id: "cursorTop" });
    expect(m(k("z", { meta: true, shift: true }))).toEqual({ type: "cmd", id: "redo" });
    expect(m(k("å", { alt: true }))).toEqual({ type: "text", text: "å" });
  });
});

describe("pushStep", () => {
  it("merges consecutive typing", () => {
    const steps: MacroStep[] = [];
    pushStep(steps, { type: "text", text: "a" });
    pushStep(steps, { type: "text", text: "b" });
    pushStep(steps, { type: "cmd", id: "cursorDown" });
    pushStep(steps, { type: "text", text: "c" });
    expect(steps).toEqual([
      { type: "text", text: "ab" },
      { type: "cmd", id: "cursorDown" },
      { type: "text", text: "c" },
    ]);
  });
});
