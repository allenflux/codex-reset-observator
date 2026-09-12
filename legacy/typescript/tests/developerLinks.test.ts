import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";

import {
  DeveloperLink,
  GITHUB_REPOSITORY_URL,
} from "../components/DeveloperLink";
import { translateUI, UI_TRANSLATIONS } from "../lib/radar/i18n";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectories = ["app", "components", "lib", "public"];
const sourceExtensions = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);

function readRepoFile(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function collectSourceFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = join(root, relativeDirectory);

  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      return collectSourceFiles(relativePath);
    }

    return sourceExtensions.has(extname(entry.name)) ? [relativePath] : [];
  });
}

test("developer link renders the GitHub URL with safe external-link attributes", () => {
  const html = renderToStaticMarkup(
    React.createElement(DeveloperLink, { locale: "en" }),
  );

  assert.match(html, /href="https:\/\/github\.com\/gussuri\/codex-reset-observatory"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /aria-label="View Codex Reset Observatory development on GitHub"/);
  assert.match(html, /View development on GitHub/);
  assert.strictEqual(GITHUB_REPOSITORY_URL, "https://github.com/gussuri/codex-reset-observatory");
});

test("developer link translations are complete for all supported locales", () => {
  const expected = {
    ja: "GitHubで開発を見る",
    en: "View development on GitHub",
    zh: "在 GitHub 查看开发",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    assert.strictEqual(translateUI("githubDevelopmentLink", locale), expected[locale]);
    assert.ok(UI_TRANSLATIONS.githubDevelopmentAriaLabel?.[locale]);
    assert.ok(UI_TRANSLATIONS.aboutDeveloper?.[locale]);
  }

  assert.doesNotMatch(UI_TRANSLATIONS.githubDevelopmentAriaLabel.en, /[\u3040-\u30ff\u4e00-\u9faf]/);
  assert.doesNotMatch(UI_TRANSLATIONS.aboutDeveloper.en, /[\u3040-\u30ff\u4e00-\u9faf]/);
});

test("all page-level navigation surfaces include the shared developer link", () => {
  for (const component of [
    "components/RadarDashboard.tsx",
    "components/HistoryView.tsx",
    "components/AboutView.tsx",
    "components/FaqView.tsx",
  ]) {
    assert.match(readRepoFile(component), /<DeveloperLink\s/);
  }
});

test("the site source does not expose the developer X profile directly", () => {
  const source = sourceDirectories
    .flatMap(collectSourceFiles)
    .map(readRepoFile)
    .join("\n");

  assert.doesNotMatch(source, /https:\/\/x\.com\/gussuri_s/);
});

test("README contains the developer X profile link without changing site source", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /## Developer/);
  assert.match(readme, /\[Xで開発者をフォロー\]\(https:\/\/x\.com\/gussuri_s\)/);
});
