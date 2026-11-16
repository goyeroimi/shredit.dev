import type { Metadata } from "next";
import ChangelogPage from "@/components/changelog-page";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Policy changes",
  description:
    "Dated history of material changes to Shredit's privacy, security, terms, and abuse policies.",
  alternates: { canonical: "/changelog" },
};

export default async function Page() {
  return (
    <ChangelogPage
      publicConfig={getPublicRuntimeConfig()}
      initialLocale={await getRequestLocale()}
    />
  );
}
