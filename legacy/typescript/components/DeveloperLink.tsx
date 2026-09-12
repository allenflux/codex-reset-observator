import { Github } from "lucide-react";
import React from "react";
import type { Locale } from "@/lib/radar/types";
import { translateUI } from "@/lib/radar/i18n";

export const GITHUB_REPOSITORY_URL =
  "https://github.com/gussuri/codex-reset-observatory";

type DeveloperLinkProps = {
  locale: Locale;
  className?: string;
};

export function DeveloperLink({ locale, className = "" }: DeveloperLinkProps) {
  const linkClassName = [
    "inline-flex max-w-full items-center gap-2 whitespace-nowrap text-sm font-medium transition-colors",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <a
      aria-label={translateUI("githubDevelopmentAriaLabel", locale)}
      className={linkClassName}
      href={GITHUB_REPOSITORY_URL}
      rel="noopener noreferrer"
      target="_blank"
    >
      <Github aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 overflow-hidden text-ellipsis">
        {translateUI("githubDevelopmentLink", locale)}
      </span>
    </a>
  );
}
