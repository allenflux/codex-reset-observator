import Link from "next/link";
import type { Locale } from "@/lib/radar/types";
import { translateUI } from "@/lib/radar/i18n";
import { SITE_NAME, SITE_NAME_JA } from "@/lib/siteMetadata";
import { DeveloperLink } from "./DeveloperLink";

type AboutViewProps = {
  locale: Locale;
};

export function AboutView({ locale }: AboutViewProps) {
  const content = {
    ja: {
      category: "Codexリセット観測",
      title: SITE_NAME_JA + "について",
      subTitle: "Codexのリセット情報を観測・整理する非公式サイトです。",
      paragraphs: [
        "Codexリセット観測所は、Codexのリセット情報を観測・整理する非公式サイトです。",
        "リセット履歴、公式予告、コミュニティ上の動きなどをもとに、現在の状況を分かりやすく確認できるようまとめています。",
        "ランダムリセット期待度は、過去のリセット間隔から算出した基礎確率を現在の観測シグナルで補正した統計予測です。公式情報や確定的な確率ではありません。",
        "実際のリセット実施有無や時期については、必ず公式情報をご確認ください。",
        "任意リセットを使用すると、対象の利用上限が更新されます。その後の7日間枠や表示されるリセット日時は、アカウントの利用状況によって異なる場合があります。",
        "CodexとChatGPT Workは、対象プランでは同じエージェント利用量・クレジットのプールを共有しています。Codexはソフトウェア開発向け、ChatGPT Workは長めの複数ステップ作業や成果物作成向けの別の体験です。本サイトはCodexを主対象としていますが、この共有利用枠に影響するリセットは、ChatGPT Workなどの利用にも関係する場合があります。",
      ],
      nav: {
        top: "トップへ戻る",
        faq: "FAQを見る",
        history: "履歴を見る",
      },
    },
    en: {
      category: "Codex reset reference",
      title: "About " + SITE_NAME,
      subTitle: "An unofficial reference site for Codex reset history, Banked Resets, and random reset signals.",
      paragraphs: [
        SITE_NAME + " collects reset-related information in one place so users can quickly check recent reset history and the current reset situation.",
        "It brings together official reset notices and past reset history so you can compare what is happening now with earlier reset patterns.",
        "The random reset probability is a statistical forecast: a baseline derived from past reset intervals is adjusted using current observable signals. It is not an official OpenAI notice or probability.",
        "Using a Banked Reset refreshes the applicable usage limit. The resulting usage window and reset date may differ by account.",
        "On eligible plans, Codex and ChatGPT Work share the same agentic usage and credits pool. Codex remains a separate software-development experience, while Work is designed for longer multi-step tasks and finished deliverables. This site remains focused on Codex, but a reset affecting that shared pool may also affect usage in ChatGPT Work and other agentic experiences.",
      ],
      nav: {
        top: "Back to English top",
        faq: "FAQ",
        history: "History",
      },
    },
    zh: {
      category: "Codex 重置观测",
      title: "关于 " + SITE_NAME,
      subTitle: "一个用于了解 Codex 重置历史、手动重置以及随机重置信号的非官方参考网站。",
      paragraphs: [
        SITE_NAME + "旨在将重置相关的信息汇总在一处，以便用户快速查看最近的重置历史和当前的重置状况。",
        "它汇集了官方重置预告和历史重置记录，让您可以将当前状况与早期的重置模式进行对比。",
        "随机重置期望度是一种统计预测：先根据过去的重置间隔计算基础概率，再根据当前可观测信号进行调整，并非 OpenAI 官方通知或概率。",
        "使用手动重置后，适用的使用上限会被刷新。之后的使用周期以及账号中显示的重置日期可能因账号而异。",
        "在符合条件的方案中，Codex 和 ChatGPT Work 共享同一个代理式使用量和额度池。Codex仍是面向软件开发的独立体验，而 Work 更适合较长的多步骤任务和成品交付。本网站仍以 Codex 为主，但影响这一共享额度池的重置也可能影响 ChatGPT Work 等其他代理式体验的使用。",
      ],
      nav: {
        top: "返回中文首页",
        faq: "常见问题",
        history: "历史记录",
      },
    },
  }[locale];

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8" lang={locale}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <header className="rounded-lg border border-slate-200/80 bg-white/88 p-5 shadow-sm backdrop-blur">
          <p className="text-sm font-medium text-teal-700">
            {content.category}
          </p>
          <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-950">
            {content.title}
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {content.subTitle}
          </p>
        </header>

        <section className="rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm">
          <div className="space-y-4 text-sm leading-7 text-slate-700">
            {content.paragraphs.map((p, idx) => (
              <p key={idx}>{p}</p>
            ))}
            <p>{translateUI("aboutDeveloper", locale)}</p>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <DeveloperLink
              locale={locale}
              className="text-slate-600 hover:text-teal-700"
            />
            <a
              className="text-sm font-medium text-slate-600 transition-colors hover:text-teal-700"
              href="https://gussuriworks.com/"
              rel="noopener noreferrer"
              target="_blank"
            >
              by Gussuri Works
            </a>
          </div>
        </section>

        <nav className="flex flex-wrap gap-3 text-sm">
          <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href={locale === "ja" ? "/" : locale === "en" ? "/en" : "/zh"}>
            {content.nav.top}
          </Link>
          <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href={locale === "ja" ? "/faq" : locale === "en" ? "/en/faq" : "/zh/faq"}>
            {content.nav.faq}
          </Link>
          <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href={locale === "ja" ? "/history" : locale === "en" ? "/en/history" : "/zh/history"}>
            {content.nav.history}
          </Link>
          {locale === "ja" ? (
            <>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/en/about">
                English
              </Link>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/zh/about">
                简体中文
              </Link>
            </>
          ) : locale === "en" ? (
            <>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/about">
                日本語
              </Link>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/zh/about">
                简体中文
              </Link>
            </>
          ) : (
            <>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/about">
                日本語
              </Link>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/en/about">
                English
              </Link>
            </>
          )}
        </nav>
      </div>
    </main>
  );
}
