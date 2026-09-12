import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { parseTiboReplyMetadata } from "../lib/radar/tiboReplyMetadata";

type FakeElementOptions = {
  text?: string;
  attributes?: Record<string, string>;
  marker?: FakeElement | null;
  links?: FakeElement[];
  nestedArticles?: FakeElement[];
  tweetText?: FakeElement | null;
  quote?: FakeElement | null;
  throwOnQuote?: boolean;
};

type StructuralElementOptions = {
  tagName?: string;
  text?: string;
  attributes?: Record<string, string>;
};

class FakeElement {
  innerText: string;
  private readonly attributes: Record<string, string>;
  private readonly marker: FakeElement | null;
  private readonly links: FakeElement[];
  private readonly nestedArticles: FakeElement[];
  private readonly tweetText: FakeElement | null;
  private readonly quote: FakeElement | null;
  private readonly throwOnQuote: boolean;

  constructor(options: FakeElementOptions = {}) {
    this.innerText = options.text || "";
    this.attributes = options.attributes || {};
    this.marker = options.marker || null;
    this.links = options.links || [];
    this.nestedArticles = options.nestedArticles || [];
    this.tweetText = options.tweetText || null;
    this.quote = options.quote || null;
    this.throwOnQuote = options.throwOnQuote === true;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  querySelector(selector: string) {
    if (selector.includes("socialContext") || selector.includes("replyContext") || selector.includes("Replying to") || selector.includes("返信先") || selector.includes("回复给")) {
      return this.marker;
    }
    if (selector.includes('data-testid="tweetText"')) {
      return this.tweetText;
    }
    if (selector.includes("quoteTweet") || selector.includes("quotedTweet") || selector.includes("Quoted")) {
      if (this.throwOnQuote) throw new Error("quote DOM unavailable");
      return this.quote;
    }
    return null;
  }

  querySelectorAll(selector: string) {
    if (selector.includes("a[href")) return this.links;
    if (selector.includes('article[data-testid="tweet"]')) return this.nestedArticles;
    return [];
  }
}

class StructuralElement {
  readonly tagName: string;
  innerText: string;
  readonly children: StructuralElement[] = [];
  parentElement: StructuralElement | null = null;
  private readonly attributes: Record<string, string>;

  constructor(options: StructuralElementOptions = {}) {
    this.tagName = options.tagName || "div";
    this.innerText = options.text || "";
    this.attributes = options.attributes || {};
  }

  appendChild(child: StructuralElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get previousElementSibling(): StructuralElement | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  contains(candidate: StructuralElement | null) {
    if (!candidate) return false;
    let current: StructuralElement | null = candidate;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  closest(selector: string) {
    let current: StructuralElement | null = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string) {
    const matches: StructuralElement[] = [];
    const visit = (node: StructuralElement) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function matchesSelector(element: StructuralElement, selector: string) {
  if (selector === "time") return element.tagName === "time";
  if (selector === 'article[data-testid="tweet"]') {
    return element.tagName === "article" && element.getAttribute("data-testid") === "tweet";
  }
  const testIdMatch = selector.match(/^\[data-testid="([^"]+)"\]$/);
  if (testIdMatch) return element.getAttribute("data-testid") === testIdMatch[1];
  if (selector === 'a[href]') {
    return element.tagName === "a" && Boolean(element.getAttribute("href"));
  }
  if (selector === 'a[href*="/status/"]') {
    return element.tagName === "a" && (element.getAttribute("href") || "").includes("/status/");
  }
  return false;
}

function element(options: StructuralElementOptions = {}) {
  return new StructuralElement(options);
}

function makeThreadArticle(options: {
  id: string;
  handle?: string;
  text?: string;
  incoming?: boolean;
  outgoing?: boolean;
  quoteText?: string;
}) {
  const cell = element({ attributes: { "data-testid": "cellInnerDiv" } });
  const article = element({ tagName: "article", attributes: { "data-testid": "tweet" } });
  const outer = element();
  const body = element();
  const threadRow = element();
  threadRow.appendChild(element());
  if (options.incoming) threadRow.appendChild(element());

  const bodyRow = element();
  const avatarColumn = element();
  avatarColumn.appendChild(element({ attributes: { "data-testid": "Tweet-User-Avatar" } }));
  if (options.outgoing) avatarColumn.appendChild(element());

  const contentColumn = element();
  const userName = element({ attributes: { "data-testid": "User-Name" } });
  userName.appendChild(element({
    tagName: "a",
    attributes: { href: `/${options.handle || "parent"}` },
  }));
  contentColumn.appendChild(userName);

  if (options.quoteText) {
    const quoteArticle = element({ tagName: "article", attributes: { "data-testid": "tweet" } });
    const quoteText = element({ attributes: { "data-testid": "tweetText" }, text: options.quoteText });
    quoteArticle.appendChild(quoteText);
    contentColumn.appendChild(quoteArticle);
  }

  contentColumn.appendChild(element({
    attributes: { "data-testid": "tweetText" },
    text: options.text || "",
  }));
  contentColumn.appendChild(element({
    tagName: "a",
    attributes: { href: `/${options.handle || "parent"}/status/${options.id}` },
  }));
  contentColumn.appendChild(element({ tagName: "time" }));

  bodyRow.appendChild(avatarColumn);
  bodyRow.appendChild(contentColumn);
  body.appendChild(threadRow);
  body.appendChild(bodyRow);
  outer.appendChild(body);
  article.appendChild(outer);
  cell.appendChild(article);
  return { cell, article };
}

function makeTimeline(...cells: StructuralElement[]) {
  const timeline = element();
  cells.forEach((cell) => timeline.appendChild(cell));
  return timeline;
}

function loadScanUtils() {
  const code = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/scan-utils.js"),
    "utf8",
  );
  const context = vm.createContext({ URL, Date });
  vm.runInContext(code, context);
  return (context as typeof context & {
    TiboMonitorScan: {
      getTimelineSource: (url: string) => string | null;
      extractReplyMetadata: (article: FakeElement | StructuralElement, options?: { sourceTimeline?: string | null }) => {
        isReply: boolean;
        replyToHandles: string[];
        replyContextText: string | null;
        needsRetry?: boolean;
        isQuote: boolean;
        quoteContextText: string | null;
        quoteTweetUrl: string | null;
        quoteAuthorHandle: string | null;
      };
    };
  }).TiboMonitorScan;
}

test("reply metadata parser accepts bounded optional metadata and keeps old payloads valid", () => {
  assert.deepEqual(parseTiboReplyMetadata({}), {
    ok: true,
    value: {},
  });
  assert.deepEqual(
    parseTiboReplyMetadata({
      isReply: true,
      replyToHandles: ["alice", "@alice", "bob_2"],
      replyContextText: "  Parent context  ",
      sourceTimeline: "with_replies",
    }),
    {
      ok: true,
      value: {
        isReply: true,
        replyToHandles: ["@alice", "@bob_2"],
        replyContextText: "Parent context",
        sourceTimeline: "with_replies",
      },
    },
  );
});

test("reply metadata parser rejects unsafe or oversized supplied values", () => {
  assert.equal(parseTiboReplyMetadata({ isReply: "true" }).ok, false);
  assert.equal(parseTiboReplyMetadata({ sourceTimeline: "notifications" }).ok, false);
  assert.equal(parseTiboReplyMetadata({ replyToHandles: ["not a handle"] }).ok, false);
  assert.equal(parseTiboReplyMetadata({ replyContextText: "x".repeat(1001) }).ok, false);
});

test("quote metadata parser accepts safe nullable fields and normalizes the handle", () => {
  assert.deepEqual(
    parseTiboReplyMetadata({
      isQuote: true,
      quoteContextText: "  So what about our reset?  ",
      quoteTweetUrl: "https://x.com/blueemi99/status/1234567890",
      quoteAuthorHandle: "blueemi99",
    }),
    {
      ok: true,
      value: {
        isQuote: true,
        quoteContextText: "So what about our reset?",
        quoteTweetUrl: "https://x.com/blueemi99/status/1234567890",
        quoteAuthorHandle: "@blueemi99",
      },
    },
  );
});

test("quote metadata parser rejects unsafe or oversized fields", () => {
  assert.equal(parseTiboReplyMetadata({ quoteAuthorHandle: "@not-valid-handle!" }).ok, false);
  assert.equal(parseTiboReplyMetadata({ quoteTweetUrl: "https://evil.example/status/123" }).ok, false);
  assert.equal(parseTiboReplyMetadata({ quoteContextText: "x".repeat(1001) }).ok, false);
});

test("timeline source recognizes profile and with-replies pages on both X hosts", () => {
  const scan = loadScanUtils();
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux"), "profile");
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux/with_replies"), "with_replies");
  assert.equal(scan.getTimelineSource("https://twitter.com/thsottiaux/with_replies/"), "with_replies");
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux/status/123"), null);
});

test("explicit Replying to DOM metadata identifies a reply and visible parent context", () => {
  const scan = loadScanUtils();
  const link = new FakeElement({ attributes: { href: "/alice" } });
  const marker = new FakeElement({
    text: "Replying to @alice",
    attributes: { "aria-label": "Replying to @alice" },
    links: [link],
  });
  const parentText = new FakeElement({ text: "The parent post is visible." });
  const parent = new FakeElement({ tweetText: parentText });
  const article = new FakeElement({ marker, nestedArticles: [parent] });

  assert.equal(JSON.stringify(scan.extractReplyMetadata(article)), JSON.stringify({
    isReply: true,
    replyToHandles: ["@alice"],
    replyContextText: "The parent post is visible.",
    isQuote: false,
    quoteContextText: null,
    quoteTweetUrl: null,
    quoteAuthorHandle: null,
  }));
});

test("quote card metadata is collected best-effort without changing author text", () => {
  const scan = loadScanUtils();
  const quoteText = new FakeElement({ text: "So what about our reset?" });
  const quoteLink = new FakeElement({
    attributes: { href: "https://x.com/blueemi99/status/9876543210" },
  });
  const quote = new FakeElement({ tweetText: quoteText, links: [quoteLink] });
  const article = new FakeElement({ quote });

  assert.equal(JSON.stringify(scan.extractReplyMetadata(article)), JSON.stringify({
    isReply: false,
    replyToHandles: [],
    replyContextText: null,
    isQuote: true,
    quoteContextText: "So what about our reset?",
    quoteTweetUrl: "https://x.com/blueemi99/status/9876543210",
    quoteAuthorHandle: "@blueemi99",
  }));
});

test("quote DOM failures do not stop ordinary tweet collection", () => {
  const scan = loadScanUtils();
  const article = new FakeElement({ throwOnQuote: true });

  assert.equal(JSON.stringify(scan.extractReplyMetadata(article)), JSON.stringify({
    isReply: false,
    replyToHandles: [],
    replyContextText: null,
    isQuote: false,
    quoteContextText: null,
    quoteTweetUrl: null,
    quoteAuthorHandle: null,
  }));
});

test("a normal post or contextless reply does not invent reply context", () => {
  const scan = loadScanUtils();
  const normalArticle = new FakeElement({ text: "A normal post" });
  assert.equal(JSON.stringify(scan.extractReplyMetadata(normalArticle)), JSON.stringify({
    isReply: false,
    replyToHandles: [],
    replyContextText: null,
    isQuote: false,
    quoteContextText: null,
    quoteTweetUrl: null,
    quoteAuthorHandle: null,
  }));

  const marker = new FakeElement({ text: "Replying to @alice", links: [] });
  const replyWithoutParent = new FakeElement({ marker, nestedArticles: [] });
  assert.equal(JSON.stringify(scan.extractReplyMetadata(replyWithoutParent)), JSON.stringify({
    isReply: true,
    replyToHandles: ["@alice"],
    replyContextText: null,
    isQuote: false,
    quoteContextText: null,
    quoteTweetUrl: null,
    quoteAuthorHandle: null,
  }));
});

test("with-replies sibling connectors recover the two observed Tibo reply parents", () => {
  const scan = loadScanUtils();
  const cases = [
    {
      id: "2089063967301730789",
      parentText: "are we going to get a reset when codex crosses 20M users?",
    },
    {
      id: "2089078284487139347",
      parentText: '"maybe" from tibo is basically a confirmed reset',
    },
  ];

  for (const testCase of cases) {
    const parent = makeThreadArticle({
      id: `parent-${testCase.id}`,
      handle: "Ananth7e",
      text: testCase.parentText,
      outgoing: true,
    });
    const child = makeThreadArticle({
      id: testCase.id,
      handle: "thsottiaux",
      text: "Maybe",
      incoming: true,
    });
    makeTimeline(parent.cell, child.cell);

    assert.equal(JSON.stringify(scan.extractReplyMetadata(child.article, { sourceTimeline: "with_replies" })), JSON.stringify({
      isReply: true,
      replyToHandles: ["@Ananth7e"],
      replyContextText: testCase.parentText,
      isQuote: false,
      quoteContextText: null,
      quoteTweetUrl: null,
      quoteAuthorHandle: null,
    }));
  }
});

test("adjacent ordinary posts and connector mismatches are not treated as replies", () => {
  const scan = loadScanUtils();
  const ordinaryParent = makeThreadArticle({ id: "parent", handle: "alice", text: "ordinary" });
  const ordinaryChild = makeThreadArticle({ id: "child", handle: "thsottiaux", text: "Maybe" });
  makeTimeline(ordinaryParent.cell, ordinaryChild.cell);
  assert.equal(scan.extractReplyMetadata(ordinaryChild.article, { sourceTimeline: "with_replies" }).isReply, false);

  const incomingWithoutOutgoing = makeThreadArticle({ id: "child-2", handle: "thsottiaux", text: "Maybe", incoming: true });
  makeTimeline(ordinaryParent.cell, incomingWithoutOutgoing.cell);
  const mismatch = scan.extractReplyMetadata(incomingWithoutOutgoing.article, { sourceTimeline: "with_replies" });
  assert.equal(mismatch.isReply, false);
  assert.equal(mismatch.needsRetry, true);

  const outgoingWithoutIncoming = makeThreadArticle({ id: "parent-2", handle: "alice", text: "ordinary", outgoing: true });
  const noIncomingChild = makeThreadArticle({ id: "child-3", handle: "thsottiaux", text: "Maybe" });
  makeTimeline(outgoingWithoutIncoming.cell, noIncomingChild.cell);
  assert.equal(scan.extractReplyMetadata(noIncomingChild.article, { sourceTimeline: "with_replies" }).isReply, false);
});

test("an incoming connector without a rendered parent requests a retry", () => {
  const scan = loadScanUtils();
  const child = makeThreadArticle({ id: "partial", handle: "thsottiaux", text: "Maybe", incoming: true });

  assert.equal(JSON.stringify(scan.extractReplyMetadata(child.article, { sourceTimeline: "with_replies" })), JSON.stringify({
    isReply: false,
    replyToHandles: [],
    replyContextText: null,
    needsRetry: true,
    isQuote: false,
    quoteContextText: null,
    quoteTweetUrl: null,
    quoteAuthorHandle: null,
  }));
});

test("sibling parent context uses its own text, not nested quote text", () => {
  const scan = loadScanUtils();
  const parent = makeThreadArticle({
    id: "parent-with-quote",
    handle: "alice",
    text: "The parent's own post",
    quoteText: "Quoted text must not become the parent context",
    outgoing: true,
  });
  const child = makeThreadArticle({ id: "child-with-quote", handle: "thsottiaux", text: "Maybe", incoming: true });
  makeTimeline(parent.cell, child.cell);

  assert.equal(
    scan.extractReplyMetadata(child.article, { sourceTimeline: "with_replies" }).replyContextText,
    "The parent's own post",
  );
});

test("multi-level thread connectors use the immediate parent and profile pages do not infer siblings", () => {
  const scan = loadScanUtils();
  const grandParent = makeThreadArticle({ id: "grand-parent", handle: "root", text: "root", outgoing: true });
  const parent = makeThreadArticle({ id: "parent-level", handle: "middle", text: "middle", incoming: true, outgoing: true });
  const child = makeThreadArticle({ id: "child-level", handle: "thsottiaux", text: "Maybe", incoming: true });
  makeTimeline(grandParent.cell, parent.cell, child.cell);

  assert.equal(
    scan.extractReplyMetadata(child.article, { sourceTimeline: "with_replies" }).replyContextText,
    "middle",
  );
  assert.equal(scan.extractReplyMetadata(child.article, { sourceTimeline: "profile" }).isReply, false);
});
