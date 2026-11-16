"use client";

import { messages, type Locale } from "@/lib/messages";
import type { PublicRuntimeConfig } from "@/lib/public-config";
import { ShreditShell } from "@/components/shredit-ui";
import { useLocale } from "@/lib/use-locale";

export default function ChangelogPage({
  publicConfig,
  initialLocale,
}: {
  publicConfig: PublicRuntimeConfig;
  initialLocale: Locale;
}) {
  const [locale, setLocale] = useLocale(initialLocale);
  const labels = messages[locale];
  const data = labels.changelog;
  return (
    <ShreditShell
      locale={locale}
      onLocaleChange={setLocale}
      publicConfig={publicConfig}
    >
      <main id="main-content" className="legal-layout" tabIndex={-1}>
        <article className="legal-content">
          <div className="workspace-bar">
            <div className="workspace-bar-group">
              <span className="workspace-label">Shredit</span>
              <span className="workspace-divider" aria-hidden="true" />
              <span>{data.title}</span>
            </div>
          </div>
          <div className="legal-document">
            <p className="section-kicker">Shredit / {data.title}</p>
            <h1>{data.title}</h1>
            <p className="legal-intro">{data.intro}</p>
            <p className="legal-meta">{labels.legalReviewed}</p>
            <ol className="changelog-list">
              {data.entries.map((entry) => (
                <li key={entry.date}>
                  <time dateTime={entry.date}>{entry.label}</time>
                  <div>
                    <h2>{entry.title}</h2>
                    <p>{entry.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </article>
      </main>
    </ShreditShell>
  );
}
