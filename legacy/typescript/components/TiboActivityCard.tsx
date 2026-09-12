import { ExternalLink, MessageCircle } from "lucide-react";
import { LocalizedDateTime } from "@/components/LocalizedDateTime";
import { translateUI } from "@/lib/radar/i18n";
import { getTiboDisplayLabel } from "@/lib/radar/tiboHandle";
import type { Locale, PublicTiboActivity } from "@/lib/radar/types";

function getClassificationKey(
  activity: PublicTiboActivity,
) {
  if (activity.classification === "official_notice") {
    return "tiboClassificationOfficialNotice";
  }
  if (activity.teaserStrength === "strong") {
    return "tiboClassificationStrongTeaser";
  }
  if (activity.teaserStrength === "weak") {
    return "tiboClassificationWeakTeaser";
  }

  switch (activity.classification) {
    case "reset_executed":
      return "tiboClassificationResetExecuted";
    case "teaser":
      return "tiboClassificationTeaser";
    case "irrelevant":
      return "tiboClassificationIrrelevant";
  }
}

function getQuoteMarks(locale: Locale) {
  return locale === "en"
    ? { opening: "“", closing: "”" }
    : { opening: "「", closing: "」" };
}

export function TiboActivityCard({
  activity,
  locale,
  variant = "latest",
}: {
  activity: PublicTiboActivity;
  locale: Locale;
  variant?: "related" | "latest";
}) {
  const quoteMarks = getQuoteMarks(locale);
  const hasReplyContext = activity.isReply &&
    (Boolean(activity.replyContextText) || activity.replyToHandles.length > 0);

  function renderQuotedText(text: string) {
    return (
      <blockquote className="min-w-0 border-l-4 border-teal-200 bg-slate-50/80 px-4 py-3 text-base leading-7 text-slate-700 sm:px-5 sm:py-4 sm:text-lg sm:leading-8">
        <span aria-hidden="true" className="mr-1 text-xl font-semibold text-teal-700">
          {quoteMarks.opening}
        </span>
        <span className="whitespace-pre-wrap break-words">{text}</span>
        <span aria-hidden="true" className="ml-1 text-xl font-semibold text-teal-700">
          {quoteMarks.closing}
        </span>
      </blockquote>
    );
  }

  return (
    <section
      aria-labelledby="tibo-activity-heading"
      className="rounded-lg border border-slate-200 bg-white/80 p-4 text-slate-700 shadow-sm sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="tibo-activity-heading"
            className="text-xl font-semibold leading-tight text-slate-950 sm:text-2xl"
          >
            {translateUI(
              variant === "related" ? "tiboRelatedActivity" : "tiboLatestActivity",
              locale,
            )}
          </h2>
          <p className="mt-1 text-sm font-medium text-slate-500">
            {getTiboDisplayLabel(activity.sourceUrl)}
          </p>
        </div>
        <MessageCircle className="h-6 w-6 shrink-0 text-teal-700" aria-hidden="true" />
      </div>

      {hasReplyContext ? (
        <div className="mt-4 min-w-0 space-y-2">
          <p className="text-sm font-semibold text-slate-500">
            {translateUI("tiboReplyToPost", locale)}
          </p>
          {activity.replyToHandles.length > 0 ? (
            <p className="break-words text-sm font-semibold text-slate-700">
              {activity.replyToHandles.join(", ")}
            </p>
          ) : null}
          {activity.replyContextText ? renderQuotedText(activity.replyContextText) : null}
        </div>
      ) : null}
      {activity.text ? (
        <div className="mt-4">
          {activity.isReply ? (
            <p className="mb-2 text-sm font-semibold text-slate-500">
              {translateUI("tiboReply", locale)}
            </p>
          ) : null}
          {renderQuotedText(activity.text)}
        </div>
      ) : (
        <p className="mt-4 min-w-0 text-base leading-7 text-slate-700 sm:text-lg sm:leading-8">
          {translateUI("tiboNoPostText", locale)}
        </p>
      )}

      <dl className="mt-5 grid gap-4 border-t border-slate-200 pt-4 text-sm sm:grid-cols-3 sm:items-start">
        <div>
          <dt className="text-sm font-semibold text-slate-500">
            {translateUI("tiboObservedClassification", locale)}
          </dt>
          <dd className="mt-1 text-base font-semibold text-slate-950">
            {translateUI(getClassificationKey(activity), locale)}
          </dd>
        </div>
        <div>
          <dt className="text-sm font-semibold text-slate-500">
            {translateUI("tiboPostDate", locale)}
          </dt>
          <dd className="mt-1 text-base font-semibold text-slate-700">
            <LocalizedDateTime value={activity.createdAt} locale={locale} />
          </dd>
        </div>
        {activity.sourceUrl ? (
          <div>
            <dt className="sr-only">{translateUI("source", locale)}</dt>
            <dd>
              <a
                className="inline-flex items-center gap-1 text-base font-semibold text-teal-700 underline-offset-4 hover:underline"
                href={activity.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {translateUI("tiboViewPost", locale)}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
