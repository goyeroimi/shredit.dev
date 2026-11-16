import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Terms",
  description:
    "Shredit terms of use: lawful plain text sharing, at-most-once delivery, and service limits.",
  alternates: { canonical: "/terms" },
};
export default async function Page() {
  return (
    <LegalPage
      kind="terms"
      publicConfig={getPublicRuntimeConfig()}
      initialLocale={await getRequestLocale()}
    />
  );
}
