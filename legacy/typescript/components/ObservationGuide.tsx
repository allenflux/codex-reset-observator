import Link from "next/link";
import React from "react";
import type { Locale } from "@/lib/radar/types";
import { ChevronDown, HelpCircle, Info } from "lucide-react";

type ObservationGuideProps = {
  locale: Locale;
};

type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

type GuideContent = {
  sectionTitle: string;
  overviewHeading: string;
  overviewParagraphs: string[];
  faqHeading: string;
  faqSubheading: string;
  viewMoreFaq: string;
  faqs: FaqItem[];
};

const GUIDE_CONTENT: Record<Locale, GuideContent> = {
  ja: {
    sectionTitle: "Codexリセット観測ガイド & FAQ",
    overviewHeading: "利用枠上限への備えと予測シグナルの読み解き方",
    overviewParagraphs: [
      "CodexはAI支援コーディングの中核ツールですが、週次制限やレート制限の上限に達すると作業が一時停止します。本観測所では、過去の全体リセット実績、公式アナウンス、障害対応に伴う臨時リセット（詫びリセット・ご祝儀リセット）の動向をリアルタイムに集約し、開発作業の停滞を防ぐための判断材料を提供しています。",
      "「リセット期待度（24時間・48時間以内）」は、過去の発生間隔データをもとにした統計モデルに、OpenAI Status（API・Codex障害の発生と復旧）、開発関係者による予告や匂わせ投稿（示唆された時間窓や強さの解析）、コミュニティからの報告を機械的に統合して算出しています。OpenAI公式の保証値ではありませんが、計画的な利用や任意リセット（Banked Reset）の使用タイミング判断にお役立ていただけます。",
    ],
    faqHeading: "よくある質問（FAQ）",
    faqSubheading: "Codex・ChatGPT Workのリセットに関する要点をまとめています。",
    viewMoreFaq: "すべてのFAQを見る（全16問） →",
    faqs: [
      {
        id: "forecast-method",
        question: "リセット期待度とは何ですか？どのように計算されますか？",
        answer:
          "今後リセットが行われる可能性の統計的な目安です。過去の発生間隔データをもとにした基準モデルに、OpenAI公式予告、OpenAI Statusの障害情報、コミュニティの動きなど現在の観測シグナルを統合・補正して算出しています。OpenAI公式の確定情報ではありません。",
      },
      {
        id: "reset-types",
        question: "定期リセットと臨時リセット（詫び・ご祝儀）の違いは？",
        answer:
          "定期リセットはアカウントごとに決まった周期で自動更新される通常の利用枠更新です。臨時リセットは、サービス障害への補償（詫びリセット）や記念イベント（ご祝儀リセット）などをきっかけにOpenAI側から全体または特定対象へ向けて突発的に提供される特別なリセットです。",
      },
      {
        id: "chatgpt-work-reset",
        question: "ChatGPT Workのリセットも関係ありますか？",
        answer:
          "はい。対象プランでは、CodexとChatGPT Workは同じエージェント利用量・クレジットのプールを共有しています。そのため共有枠に対するリセットであれば、CodexだけでなくChatGPT Workの利用上限回復にも直接関係します。",
      },
      {
        id: "teaser-forecast-method",
        question: "リセット匂わせ投稿は予測にどう反映されますか？",
        answer:
          "開発関係者等の匂わせ投稿は公式予告とは区別して解析されます。「tomorrow」「tonight」や曜日・時刻などの時間的示唆が検出できる場合は、その時間窓が24時間・48時間の予測範囲と重なる度合いや示唆の強さを計算に反映します。時間が特定できない場合は投稿の新しさに応じて影響度を減衰させます。",
      },
      {
        id: "banked-reset-timing",
        question: "任意リセット（Banked Reset）はいつ使うべきですか？",
        answer:
          "任意リセットは、保有しているリセット枠を自分の好きなタイミングで消費して利用枠を満杯に戻せる機能です。全体リセットが近い（期待度が高い）時間帯は待機し、期待度が低くどうしても作業を止められない場面で任意リセットを切る、といった戦略的な使い分けが効果的です。",
      },
    ],
  },
  en: {
    sectionTitle: "Codex Reset Observatory Guide & FAQ",
    overviewHeading: "Preparing for usage limits and reading forecast signals",
    overviewParagraphs: [
      "Codex is an essential agentic coding companion, but hitting weekly allowance limits or rate caps halts productive development. This observatory aggregates confirmed global reset events, official notices, and incident-driven compensation resets (wabi-resets) in real time to help developers plan ahead and prevent costly downtime.",
      "The 24-hour and 48-hour reset likelihoods combine an empirical baseline derived from historical event cadence with real-time indicators: OpenAI Status incidents, developer teaser posts (evaluating hinted time windows and confidence levels), and community signals. These statistical reference values serve as practical guidance for pacing tasks or deciding when to redeem a Banked Reset.",
    ],
    faqHeading: "Frequently Asked Questions",
    faqSubheading: "Key points regarding Codex and ChatGPT Work usage limit resets.",
    viewMoreFaq: "View all FAQs (16 questions) →",
    faqs: [
      {
        id: "forecast-method",
        question: "What is the reset likelihood and how is it calculated?",
        answer:
          "It is a statistical reference forecast indicating the likelihood of an upcoming reset. An empirical baseline derived from historical cadence is dynamically calibrated using official notices, OpenAI Status incident logs, and community signals. It is not an official probability from OpenAI.",
      },
      {
        id: "reset-types",
        question: "What is the difference between regular cycles and special resets?",
        answer:
          "Regular resets follow scheduled periodic refreshes. Special or compensation resets (often called wabi-resets or celebration resets) are unscheduled events executed by OpenAI following service outages, capacity issues, or milestone events.",
      },
      {
        id: "chatgpt-work-reset",
        question: "Does a Codex reset also affect ChatGPT Work?",
        answer:
          "Yes. On eligible plans, Codex and ChatGPT Work share the same agentic usage and credits pool. A reset affecting that shared pool restores limits for both Codex and ChatGPT Work, though applicability may vary depending on plan specifics.",
      },
      {
        id: "teaser-forecast-method",
        question: "How are reset teaser posts reflected in the forecast?",
        answer:
          "Teaser posts are analyzed separately from official notices. When terms like tomorrow, tonight, weekdays, or specific hours are resolved, the forecast weighs the hinted window overlap and hint strength against the 24h and 48h windows. Unresolvable hints decay gradually over time.",
      },
      {
        id: "banked-reset-timing",
        question: "When should I use a Banked Reset (Manual Reset)?",
        answer:
          "A Banked Reset allows you to manually refresh your usage limits on demand. It is best used strategically: when reset likelihood is low and immediate progress is essential, use your Banked Reset; when likelihood is high or an official notice is imminent, consider waiting for a potential global reset.",
      },
    ],
  },
  zh: {
    sectionTitle: "Codex 重置观测指南与 FAQ",
    overviewHeading: "应对使用额度上限与理解预测信号",
    overviewParagraphs: [
      "Codex 是不可或缺的开发助手，但遇到周期限额或速率上限时会导致开发流程中断。本站实时汇总全局重置历史、官方公告以及因故障引发的补偿重置（赔偿重置/庆祝重置），协助开发者合理规划工作、减少等待时间。",
      "24小时及48小时重置可能性基于历史重置周期数据建立的基准模型，并结合 OpenAI Status 故障状态、开发团队成员的暗示发帖（解析提及的时间窗口与暗示强度）及社区反馈综合计算得出。该数值为统计参考指标，可作为日常调度或使用手动重置（Banked Reset）时的决策参考。",
    ],
    faqHeading: "常见问题解答（FAQ）",
    faqSubheading: "汇总有关 Codex 与 ChatGPT Work 重置机制的关键信息。",
    viewMoreFaq: "查看全部常见问题（共16问） →",
    faqs: [
      {
        id: "forecast-method",
        question: "重置可能性是什么意思？如何计算？",
        answer:
          "重置可能性是未来发生重置的统计参考指标。本站根据历史重置周期数据建立基准模型，并结合 OpenAI 官方公告、OpenAI Status 故障信息及社区动态实时修正。该数据并非 OpenAI 官方保证。",
      },
      {
        id: "reset-types",
        question: "定期重置与临时重置（补偿/庆祝）有什么区别？",
        answer:
          "定期重置是按照账号既定周期自动刷新的常规额度更新；临时重置则是 OpenAI 因服务中断故障补偿（赔偿重置）或里程碑庆祝活动而临时额外触发的特殊重置。",
      },
      {
        id: "chatgpt-work-reset",
        question: "Codex 的重置也会影响 ChatGPT Work 吗？",
        answer:
          "会。在符合条件的方案中，Codex 与 ChatGPT Work 共享同一个代理式使用量与额度池。因此，针对该共享额度池的重置将同时恢复两者的可用额度。",
      },
      {
        id: "teaser-forecast-method",
        question: "重置暗示帖如何影响预测？",
        answer:
          "暗示帖与官方公告分开处理。若能解析出 tomorrow、tonight、星期或具体时间段，算法会根据暗示时间窗口与未来24/48小时预测区间的重叠度及暗示强度进行修正；无法解析时间的帖子则会随时间衰减影响。",
      },
      {
        id: "banked-reset-timing",
        question: "应该在什么时候使用手动重置（Banked Reset）？",
        answer:
          "手动重置允许您自主选择刷新当前使用上限的时机。建议在重置可能性较低且急需继续编码时使用；当重置可能性极高或已有官方预告时，建议稍作等待以节约手动重置机会。",
      },
    ],
  },
};

export function ObservationGuide({ locale }: ObservationGuideProps) {
  const content = GUIDE_CONTENT[locale] ?? GUIDE_CONTENT.ja;
  const faqUrl = locale === "ja" ? "/faq" : `/${locale}/faq`;

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: content.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };

  return (
    <section
      aria-labelledby="observation-guide-title"
      className="space-y-6 rounded-lg border border-slate-200/80 bg-white/90 p-5 shadow-sm backdrop-blur sm:p-6"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      {/* Guide Overview */}
      <div>
        <div className="flex items-center gap-2 text-teal-700">
          <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
          <h2
            id="observation-guide-title"
            className="text-xs font-semibold uppercase tracking-wider text-teal-700"
          >
            {content.sectionTitle}
          </h2>
        </div>
        <h3 className="mt-1 text-lg font-semibold text-slate-900">
          {content.overviewHeading}
        </h3>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-600">
          {content.overviewParagraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>

      {/* Accordion FAQ */}
      <div className="border-t border-slate-200/80 pt-5">
        <div className="flex items-center gap-2 text-teal-700">
          <HelpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <h3 className="text-base font-semibold text-slate-900">
            {content.faqHeading}
          </h3>
        </div>
        <p className="mt-1 text-xs text-slate-500">{content.faqSubheading}</p>

        <div className="mt-4 space-y-3">
          {content.faqs.map((faq) => (
            <details
              key={faq.id}
              className="group rounded-md border border-slate-200/90 bg-slate-50/70 transition-colors open:bg-white"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3.5 text-left text-sm font-medium text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
                <span>{faq.question}</span>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="border-t border-slate-100 px-3.5 pb-3.5 pt-2 text-xs leading-relaxed text-slate-600">
                <p>{faq.answer}</p>
              </div>
            </details>
          ))}
        </div>

        <div className="mt-4 text-right">
          <Link
            href={faqUrl}
            className="text-xs font-semibold text-teal-700 underline-offset-4 hover:underline"
          >
            {content.viewMoreFaq}
          </Link>
        </div>
      </div>
    </section>
  );
}
