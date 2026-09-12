import test from "node:test";
import assert from "node:assert/strict";
import { getDocumentLocale } from "../lib/locale";

test("uses the English document locale for English routes", () => {
  assert.equal(getDocumentLocale("/en"), "en");
  assert.equal(getDocumentLocale("/en/faq"), "en");
});

test("uses the Chinese document locale for Chinese routes", () => {
  assert.equal(getDocumentLocale("/zh"), "zh");
  assert.equal(getDocumentLocale("/zh/history"), "zh");
});

test("defaults document locale to Japanese", () => {
  assert.equal(getDocumentLocale("/"), "ja");
  assert.equal(getDocumentLocale("/faq"), "ja");
});

test("maps route paths to the document locale", () => {
  assert.equal(getDocumentLocale("/en"), "en");
  assert.equal(getDocumentLocale("/en/faq"), "en");
  assert.equal(getDocumentLocale("/zh/history"), "zh");
  assert.equal(getDocumentLocale("/unknown"), "ja");
});
