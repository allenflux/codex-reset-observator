import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ObservationGuide } from "../components/ObservationGuide";

test("observation guide renders for all supported locales with guide text and 5 FAQs", () => {
  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(
      React.createElement(ObservationGuide, { locale }),
    );

    // Guide section
    assert.match(html, /aria-labelledby="observation-guide-title"/);

    // FAQ schema
    assert.match(html, /"FAQPage"/);
    assert.match(html, /"Question"/);
    assert.match(html, /"Answer"/);

    // Accordion details tag
    const detailsCount = (html.match(/<details/g) ?? []).length;
    assert.strictEqual(detailsCount, 5, `expected 5 FAQ items for locale ${locale}`);

    // FAQ link
    const expectedLink = locale === "ja" ? 'href="/faq"' : `href="/${locale}/faq"`;
    assert.match(html, new RegExp(expectedLink));
  }
});

test("observation guide contains meaningful SEO text in Japanese", () => {
  const html = renderToStaticMarkup(
    React.createElement(ObservationGuide, { locale: "ja" }),
  );

  assert.match(html, /Codexリセット観測ガイド/);
  assert.match(html, /利用枠上限/);
  assert.match(html, /リセット期待度/);
  assert.match(html, /OpenAI Status/);
  assert.match(html, /ChatGPT Work/);
  assert.match(html, /Banked Reset/);
});
