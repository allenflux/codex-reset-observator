import Link from "next/link";
import { History } from "lucide-react";
import type { Locale, PublicRadarSnapshot } from "@/lib/radar/types";
import { translateUI } from "@/lib/radar/i18n";
import { DeveloperLink } from "./DeveloperLink";
import { LocalizedHistoryEvents } from "./LocalizedHistoryEvents";

type HistoryViewProps = {
  data: PublicRadarSnapshot;
  locale: Locale;
};

export function HistoryView({ data, locale }: HistoryViewProps) {
  const viewModel = data.viewModel;

  const content = {
    ja: {
      category: "Codexリセット履歴",
      pageTitle: "直近のリセット履歴",
      sectionTitle: "リセット履歴",
      description: "Codexの全体リセットと任意リセット配布を、新しい順にまとめています。",
      empty: "履歴データはまだ取得できていません。",
      nav: {
        top: "トップへ戻る",
        about: "Aboutを見る",
        faq: "FAQを見る",
        otherLangHistory: "English history",
      },
      footerText: "リセット履歴を表示しています。",
    },
    en: {
      category: "Codex usage limits reset history",
      pageTitle: "Recent Codex Reset Events",
      sectionTitle: "Reset history",
      description: "Global resets and Banked Reset distributions are listed together in chronological order.",
      empty: "No reset history is available yet.",
      nav: {
        top: "Back to English top",
        about: "About",
        faq: "FAQ",
        otherLangHistory: "Japanese history",
      },
      footerText: "Showing reset history.",
    },
    zh: {
      category: "Codex 重置历史",
      pageTitle: "重置记录历史",
      sectionTitle: "重置记录",
      description: "按时间倒序汇总 Codex 全局重置和手动重置发放记录。",
      empty: "暂无重置历史记录。",
      nav: {
        top: "返回中文首页",
        about: "关于我们",
        faq: "常见问题",
        otherLangHistory: "日本語履歴",
      },
      footerText: "正在显示重置历史。",
    },
  }[locale];

  const visibleItems = viewModel.recentHistory.filter(
    (item) => item.recordKind === "confirmed_global" ||
      item.recordKind === "banked_distribution" ||
      item.recordKind === "reference" ||
      item.recordKind === "regular_completed",
  );

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8" lang={locale}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="rounded-lg border border-slate-200/80 bg-white/88 p-5 shadow-sm backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-teal-700">
                {content.category}
              </p>
              <h1 className="mt-2 text-2xl font-semibold leading-tight text-slate-950 sm:text-3xl">
                {content.pageTitle}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                {content.description}
              </p>
            </div>
            <History className="mt-1 h-7 w-7 shrink-0 text-slate-700" />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-teal-200 hover:text-teal-800"
              href={locale === "ja" ? "/" : locale === "en" ? "/en" : "/zh"}
            >
              {content.nav.top}
            </Link>
            <Link
              className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-teal-200 hover:text-teal-800"
              href={locale === "ja" ? "/about" : locale === "en" ? "/en/about" : "/zh/about"}
            >
              {translateUI("about", locale)}
            </Link>
            <Link
              className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-teal-200 hover:text-teal-800"
              href={locale === "ja" ? "/faq" : locale === "en" ? "/en/faq" : "/zh/faq"}
            >
              {translateUI("faq", locale)}
            </Link>
          </div>
        </header>

        <LocalizedHistoryEvents
          title={content.sectionTitle}
          empty={content.empty}
          items={visibleItems}
          locale={locale}
        />

        <footer className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-950 p-5 text-sm text-white shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <nav className="flex flex-wrap gap-3 text-slate-300">
            <Link className="underline-offset-4 hover:underline" href={locale === "ja" ? "/" : locale === "en" ? "/en" : "/zh"}>
              {content.nav.top}
            </Link>
            <Link className="underline-offset-4 hover:underline" href={locale === "ja" ? "/about" : locale === "en" ? "/en/about" : "/zh/about"}>
              {translateUI("about", locale)}
            </Link>
            <Link className="underline-offset-4 hover:underline" href={locale === "ja" ? "/faq" : locale === "en" ? "/en/faq" : "/zh/faq"}>
              {translateUI("faq", locale)}
            </Link>
            {locale === "ja" ? (
              <>
                <Link className="underline-offset-4 hover:underline" href="/en/history">
                  English history
                </Link>
                <Link className="underline-offset-4 hover:underline" href="/zh/history">
                  简体中文历史
                </Link>
              </>
            ) : locale === "en" ? (
              <>
                <Link className="underline-offset-4 hover:underline" href="/history">
                  日本語履歴
                </Link>
                <Link className="underline-offset-4 hover:underline" href="/zh/history">
                  简体中文历史
                </Link>
              </>
            ) : (
              <>
                <Link className="underline-offset-4 hover:underline" href="/history">
                  日本語履歴
                </Link>
                <Link className="underline-offset-4 hover:underline" href="/en/history">
                  English history
                </Link>
              </>
            )}
            <DeveloperLink
              locale={locale}
              className="text-slate-300 hover:text-white"
            />
            <a
              className="text-sm font-medium text-slate-300 transition-colors hover:text-white"
              href="https://gussuriworks.com/"
              rel="noopener noreferrer"
              target="_blank"
            >
              by Gussuri Works
            </a>
          </nav>
          <p className="font-semibold text-slate-300">{content.footerText}</p>
        </footer>
      </div>
    </main>
  );
}
