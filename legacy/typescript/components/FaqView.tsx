import Link from "next/link";
import type { Locale } from "@/lib/radar/types";
import { DeveloperLink } from "./DeveloperLink";

type FaqViewProps = {
  locale: Locale;
};

type FaqItem = {
  id?: string;
  question: string;
  answer: string;
};

export function FaqView({ locale }: FaqViewProps) {
  const translations = {
    ja: {
      category: "CodexリセットFAQ",
      title: "よくある質問",
      subTitle: "リセットの見方を整理しています。",
      backTop: "トップへ戻る",
      about: "Aboutを見る",
      history: "履歴を見る",
      otherLang: "English FAQ",
      faqs: [
        {
          question: "このサイトでは何を表示していますか？",
          answer: "Codexのリセット履歴、公式予告、コミュニティ上の動きなどをもとに、現在の状況を分かりやすく整理しています。",
        },
        {
          id: "forecast-method",
          question: "リセット期待度とは何ですか？",
          answer: "今後リセットが行われる可能性の目安です。過去のリセット間隔から基礎確率を算出し、公式予告、Statusの障害情報、コミュニティの動きなど現在の観測シグナルで補正しています。公式な確率ではありません。",
        },
        {
          id: "teaser-forecast-method",
          question: "リセット匂わせ投稿は予測にどう反映されますか？",
          answer: "匂わせ投稿は公式予告とは分けて扱います。tomorrow、tonight、曜日、時刻などから示唆された時期を安全に解決できる場合は、その時間窓が今後24時間・48時間の予測範囲にどれだけ重なるかを反映し、時間が分かる匂わせでは「強い・弱い」という匂わせの強さも追加補正に使います。時刻を解決できない場合は、投稿の新しさなどに応じて影響を減衰させます。匂わせは確定した公式予定ではありません。",
        },
        {
          question: "Codexのリセットタイミングはいつ分かりますか？",
          answer: "公式予告がある場合は、その内容を優先して確認します。予告がない場合は、直近の履歴やStatusの動きから現在の見立てを表示しています。",
        },
        {
          id: "chatgpt-work-reset",
          question: "ChatGPT Workのリセットも関係ありますか？",
          answer: "はい。対象プランでは、CodexとChatGPT Workは同じエージェント利用量・クレジットのプールを共有しています。その共有利用枠に対するリセットであれば、CodexだけでなくChatGPT Workの利用にも関係します。ただし、対象プランやリセットの範囲によって適用状況が異なる場合があります。",
        },
        {
          id: "reset-scope-coverage",
          question: "リセットはすべての有料プランに適用されますか？",
          answer: "必ずしもすべてのプランやアカウントに同じように適用されるとは限りません。公式に広い対象へのリセットとして告知された場合でも、プランやアカウント条件によって適用状況が異なることがあります。過去にはBusinessで未適用または遅延となった事例も確認されています。このサイトの履歴はリセットイベントの発生を中心に記録しており、各プランへの完全な適用を保証するものではありません。",
        },
        {
          id: "chatgpt-reset",
          question: "ChatGPTのリセットとCodexのリセットは同じですか？",
          answer: "いいえ、すべてのChatGPT利用制限がCodexと同じわけではありません。対象プランでは、CodexとChatGPT Workなど一部のエージェント機能が共有のエージェント利用量・クレジット枠を使用しています。この共有枠に対するリセットはCodexとChatGPT Workの両方に関係しますが、通常のChatGPT利用制限や他の機能の制限とは別の場合があります。",
        },
        {
          question: "トークン・使用量・制限・レートのリセットは同じ意味ですか？",
          answer: "検索では似た意味で使われることがあります。このサイトでは、Codexの利用上限や使用量の回復につながるリセットを中心に扱っています。",
        },
        {
          question: "詫びリセットとは何ですか？",
          answer: "障害や不具合への補償として行われるリセットです。利用上限の回復や追加付与が行われる場合があります。",
        },
        {
          question: "ご祝儀リセットとは何ですか？",
          answer: "ユーザー数到達や記念イベントなどを理由として行われる特別なリセットです。",
        },
        {
          question: "臨時リセットと定期リセットの違いは？",
          answer: "定期リセットは通常の利用枠更新です。臨時リセットは障害対応や記念イベントなどをきっかけに発生する特別なリセットです。",
        },
        {
          question: "公式予告とコミュニティ予測の違いは？",
          answer: "公式予告はOpenAIや関係者による発表です。コミュニティ予測は利用者の報告や状況証拠から期待度として整理したものです。",
        },
        {
          question: "コンテキストリセットとは関係ありますか？",
          answer: "コンテキスト圧縮や長いセッションの不具合が、利用上限の補償リセットにつながる場合があります。単なる会話や作業状態のリセットとは分けて見ています。",
        },
        {
          question: "Codex CLIのリセットも確認できますか？",
          answer: "Codex全体の利用上限やStatusに関係する動きは参考になります。一方で、CLIの設定初期化やローカル環境のリセットはこのサイトの対象外です。",
        },
        {
          question: "このサイトの情報はどこから取得していますか？",
          answer: "過去のリセット履歴、公式発表、OpenAI Status、コミュニティ上の公開情報などを参考にしています。",
        },
        {
          question: "任意リセットを使うとどうなりますか？",
          answer: "任意リセットを使用すると、対象の利用上限が更新されます。その後の7日間枠や表示されるリセット日時は、アカウントの利用状況によって異なる場合があります。",
        },
      ] as Array<FaqItem>,
    },
    en: {
      category: "Codex Reset FAQ",
      title: "Frequently Asked Questions",
      subTitle: "A short guide to Codex usage limits resets, reset timing, Banked Resets, and forecast changes.",
      backTop: "Back to English top",
      about: "About",
      history: "History",
      otherLang: "Japanese FAQ",
      faqs: [
        {
          question: "Did Codex reset today?",
          answer: "Check the latest reset card and recent reset history on the top page. If a reset was confirmed today, it should appear as a recent reset event. If there is only a forecast, treat it as an estimate rather than a confirmed reset.",
        },
        {
          question: "When is the next Codex usage limits reset?",
          answer: "OpenAI does not always publish an exact reset time. This site shows official notices and estimates whether a usage-limits reset looks likely within the next 24 or 48 hours.",
        },
        {
          id: "chatgpt-work-reset",
          question: "Does a Codex reset also affect ChatGPT Work?",
          answer: "Yes. On eligible plans, Codex and ChatGPT Work share the same agentic usage and credits pool. A reset affecting that shared pool can therefore affect both Codex and ChatGPT Work, although the applicable scope may vary by plan and event.",
        },
        {
          id: "reset-scope-coverage",
          question: "Does a reset always apply to every paid plan?",
          answer: "Not always. Even when an official notice describes a reset as applying broadly, the actual application can vary by plan or account conditions. We have seen past cases where Business was not included or was updated later. This site's history records the occurrence of reset events and does not guarantee that every plan received the reset in exactly the same way.",
        },
        {
          id: "chatgpt-reset",
          question: "Is a ChatGPT reset the same as a Codex reset?",
          answer: "Not all ChatGPT usage limits are the same as Codex limits. On eligible plans, Codex, ChatGPT Work, and certain other agentic experiences share an agentic usage and credits pool. A reset affecting that shared pool can therefore affect both Codex and ChatGPT Work, while other ChatGPT limits may be separate.",
        },
        {
          question: "How does Codex reset work?",
          answer: "A Codex reset usually restores or refreshes usage limits such as weekly limits or shorter usage windows. Some resets follow a regular cycle, while others may happen after incidents, capacity issues, or special events.",
        },
        {
          question: "What is a Codex Banked Reset (Manual Reset)?",
          answer: "A Banked Reset is an account-specific reset available in your account. Using it refreshes the applicable usage limit. The resulting usage window and reset date may differ by account.",
        },
        {
          question: "What is Codex usage limits reset?",
          answer: "It means the Codex usage allowance or rate-limit window is refreshed. People may search for it as a token reset, limit reset, usage reset, or rate reset; this site groups those searches around Codex usage-limit recovery.",
        },
        {
          question: "Why does the reset forecast change?",
          answer: "The forecast starts with a baseline derived from past reset intervals and is adjusted as official notices, OpenAI Status incidents, capacity or rate-limit signals, community reports, and current timing change. The percentage is not guaranteed and may move up or down.",
        },
        {
          question: "What does this site track?",
          answer: "It tracks Codex usage-limits reset notices, reset history, and random reset probability based on public information, community activity, and OpenAI Status updates.",
        },
        {
          id: "forecast-method",
          question: "What is the random reset probability?",
          answer: "It is a statistical reference forecast. A baseline derived from past reset intervals is adjusted using official notices, Status incident logs, community reports, and other current signals. It is not an official probability.",
        },
        {
          id: "teaser-forecast-method",
          question: "How are reset teaser posts reflected in the forecast?",
          answer: "Teaser posts are treated separately from official notices. When wording such as tomorrow, tonight, a weekday, or a clock time can be resolved safely, the forecast reflects how much that hinted window overlaps the next 24 and 48 hours; for timed teasers, weak or strong hint strength is also used as an additional adjustment. If the timing cannot be resolved, the effect decays with the age of the post. A teaser is not a confirmed official schedule.",
        },
        {
          question: "When can I know the Codex reset timing?",
          answer: "If there is an official notice, that takes priority. If there is no notice, this site shows the current estimate based on recent history and OpenAI Status activity.",
        },
        {
          question: "Are token, usage, limit, and rate resets the same thing?",
          answer: "People often use those terms loosely when searching. This site focuses on resets that restore or affect Codex usage limits.",
        },
        {
          question: "What is a compensation reset (Wabi-reset)?",
          answer: "A reset executed as compensation for incidents or issues. It may restore usage limits or grant additional Banked Resets to affected plans.",
        },
        {
          question: "What is a celebration reset?",
          answer: "A special reset executed to celebrate milestones like user count achievements or product anniversaries.",
        },
        {
          question: "What is the difference between a Hard Reset and a Banked Reset?",
          answer: "A Hard Reset (Forced Reset) is a global, administrative reset executed by OpenAI for all users simultaneously. A Banked Reset (Manual Reset) is an account-specific reset that you can manually trigger whenever you choose.",
        },
        {
          question: "What is the difference between official notices and community signals?",
          answer: "Official notices are announcements by OpenAI or members of the Codex team (such as Tibo). Community signals are gathered from user reports and circumstantial evidence.",
        },
        {
          question: "Is a context reset related to Codex usage resets?",
          answer: "They are generally different concepts. While a local context reset affects session state, a usage-limit reset restores the usage allowance. However, they may occasionally overlap if context-related updates trigger a compensation reset.",
        },
        {
          question: "Does this site track Codex CLI resets?",
          answer: "While CLI issues affecting Codex usage limits or status updates are relevant, local CLI settings initialization or environment resets are outside the scope of this site.",
        },
        {
          question: "Where does this site get its information?",
          answer: "It refers to confirmed past reset history, official developer notices, OpenAI Status API, and public community reports.",
        },
        {
          question: "What happens if I use a Banked Reset?",
          answer: "Using a Banked Reset refreshes the applicable usage limit. The resulting usage window and reset date may differ by account.",
        },
      ] as Array<FaqItem>,
    },
    zh: {
      category: "Codex 重置常见问题",
      title: "常见问题解答",
      subTitle: "这里汇总了有关 Codex 重置状态、重置时机以及手动重置次数的常见问题。",
      backTop: "返回中文首页",
      about: "关于我们",
      history: "历史记录",
      otherLang: "日本語 FAQ",
      faqs: [
        {
          question: "本网站提供哪些信息？",
          answer: "本站根据 Codex 重置历史、官方预告、社区动态以及 OpenAI 服务状态，整理当前的重置情况和最新进展。",
        },
        {
          id: "forecast-method",
          question: "重置可能性是什么意思？",
          answer: "重置可能性表示未来发生重置的参考概率。本站先根据过去的重置间隔计算基础概率，再根据官方预告、OpenAI Status 故障信息、社区讨论等当前观测信号进行调整。这并不是 OpenAI 官方公布的概率。",
        },
        {
          id: "teaser-forecast-method",
          question: "重置暗示帖如何影响预测？",
          answer: "暗示帖会与官方预告分开处理。当 tomorrow、tonight、星期几或具体时刻等时间表达能够被安全解析时，预测会根据该暗示时间窗口与未来24小时、48小时预测区间的重叠程度进行调整；对于可解析时间的暗示，还会将“较强/较弱”的暗示强度作为额外修正。若无法可靠解析时间，则会按照帖子的新旧程度逐步减弱其影响。暗示帖并不等同于已确认的官方安排。",
        },
        {
          question: "什么时候可以知道 Codex 重置的具体时间？",
          answer: "如果官方发布了预告，请优先查看预告中的详细信息。在没有预告的情况下，本站会根据最近的重置历史、OpenAI Status 上的故障信息和社区动态显示当前预测。",
        },
        {
          id: "chatgpt-work-reset",
          question: "Codex 的重置也会影响 ChatGPT Work 吗？",
          answer: "会。在符合条件的方案中，Codex 和 ChatGPT Work 共享同一个代理式使用量和额度池，因此影响这一共享额度池的重置也可能影响两者。不过，具体适用范围可能因方案和事件而不同。",
        },
        {
          id: "reset-scope-coverage",
          question: "重置一定会适用于所有付费方案吗？",
          answer: "不一定。即使官方公告将重置描述为适用于较广泛的范围，实际适用情况也可能因方案或账号条件而不同。过去也曾出现 Business 未适用或延迟生效的情况。本网站的历史主要记录重置事件是否发生，并不保证每个方案都以完全相同的方式获得重置。",
        },
        {
          id: "chatgpt-reset",
          question: "ChatGPT 的重置和 Codex 的重置是同一回事吗？",
          answer: "不完全相同。并非所有 ChatGPT 使用限制都与 Codex 的限制相同。在符合条件的方案中，Codex、ChatGPT Work 和其他部分代理式体验共享代理式使用量和额度池。影响这一共享额度池的重置可能同时影响 Codex 和 ChatGPT Work，但其他 ChatGPT 使用限制可能是独立的。",
        },
        {
          question: "Token、额度、使用限制和速率限制的重置是同一回事吗？",
          answer: "用户在搜索时经常混用这些说法。本站主要关注能够恢复或影响 Codex 使用额度上限的重置事件。",
        },
        {
          question: "什么是补偿重置（Compensation reset）？",
          answer: "补偿重置是指 OpenAI 为补偿服务故障或异常问题而进行的重置。具体形式可能包括恢复使用额度，或向受影响用户发放额外的手动重置机会。",
        },
        {
          question: "什么是庆祝重置（Celebration reset）？",
          answer: "庆祝重置是指为了庆祝活跃用户数达到特定里程碑、产品发布或纪念活动等事件而进行的特殊重置。",
        },
        {
          question: "随机重置和定期重置有什么区别？",
          answer: "定期重置会按照正常的使用周期恢复额度。随机重置则是由故障补偿、庆祝活动或其他特殊事件额外触发的重置。",
        },
        {
          question: "官方预告与社区预测有什么区别？",
          answer: "官方预告是指 OpenAI 或 Codex 开发团队成员公开发布的信息。社区预测则根据用户反馈、公开线索和历史记录估算重置可能性，并不代表官方安排。",
        },
        {
          question: "这与上下文重置（Context Reset）有关吗？",
          answer: "两者通常不是同一个概念。上下文重置涉及聊天会话的上下文、压缩处理或工作状态，而本站关注的是 Codex 使用额度和使用限制的重置。如果上下文相关故障导致官方提供额度补偿，本站可能会记录该补偿事件。",
        },
        {
          question: "本站可以查询 Codex CLI 的重置吗？",
          answer: "如果某次事件影响 Codex 整体的使用额度或服务状态，本站会将其纳入参考。但 Codex CLI 的本地设置初始化、配置重置或本地环境问题不属于本站的观测范围。",
        },
        {
          question: "本网站的信息来自哪里？",
          answer: "本站参考已经确认的历史重置记录、OpenAI 或开发团队成员发布的公告、OpenAI Status 以及社区中的公开反馈。",
        },
        {
          question: "使用手动重置后会发生什么？",
          answer: "使用手动重置后，适用的使用上限会被刷新。之后的使用周期以及账号中显示的重置日期可能因账号而异。",
        },
      ] as Array<FaqItem>,
    },
  }[locale];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: translations.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8" lang={locale}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <header className="rounded-lg border border-slate-200/80 bg-white/88 p-5 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-teal-700">
                {translations.category}
              </p>
              <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-950">
                {translations.title}
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {translations.subTitle}
              </p>
            </div>
            <nav
              aria-label="FAQ navigation"
              className="flex shrink-0 flex-wrap gap-2 text-sm"
            >
              <Link
                className="rounded-md border border-teal-200 bg-teal-50 px-3 py-1.5 font-semibold text-teal-700 underline-offset-4 hover:underline"
                href={locale === "ja" ? "/" : locale === "en" ? "/en" : "/zh"}
              >
                {translations.backTop}
              </Link>
              <Link
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 underline-offset-4 hover:underline"
                href={locale === "ja" ? "/about" : locale === "en" ? "/en/about" : "/zh/about"}
              >
                {translations.about}
              </Link>
              <Link
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 underline-offset-4 hover:underline"
                href={locale === "ja" ? "/history" : locale === "en" ? "/en/history" : "/zh/history"}
              >
                {translations.history}
              </Link>
            </nav>
          </div>
        </header>

        <section className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm">
          {translations.faqs.map((faq) => (
            <article
              id={faq.id}
              className="scroll-mt-4 py-5 first:pt-0 last:pb-0"
              key={faq.question}
            >
              <h2 className="text-lg font-semibold leading-7 text-slate-950">
                {faq.question}
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-700">
                {faq.answer}
              </p>
            </article>
          ))}
        </section>

        <nav className="flex flex-wrap gap-3 text-sm">
          <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href={locale === "ja" ? "/" : locale === "en" ? "/en" : "/zh"}>
            {translations.backTop}
          </Link>
          <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href={locale === "ja" ? "/about" : locale === "en" ? "/en/about" : "/zh/about"}>
            {translations.about}
          </Link>
          <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href={locale === "ja" ? "/history" : locale === "en" ? "/en/history" : "/zh/history"}>
            {translations.history}
          </Link>
          {locale === "ja" ? (
            <>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/en/faq">
                English FAQ
              </Link>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/zh/faq">
                简体中文 FAQ
              </Link>
            </>
          ) : locale === "en" ? (
            <>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/faq">
                日本語 FAQ
              </Link>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/zh/faq">
                简体中文 FAQ
              </Link>
            </>
          ) : (
            <>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/faq">
                日本語 FAQ
              </Link>
              <Link className="font-semibold text-teal-700 underline-offset-4 hover:underline" href="/en/faq">
                English FAQ
              </Link>
            </>
          )}
        </nav>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
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
        </footer>
      </div>
    </main>
  );
}
