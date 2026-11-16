import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Security",
  description:
    "Shredit security model and threat boundaries, responsible vulnerability disclosure, and source availability under AGPL-3.0.",
  alternates: { canonical: "/security" },
};
export default async function Page() {
  return (
    <LegalPage
      kind="security"
      publicConfig={getPublicRuntimeConfig()}
      initialLocale={await getRequestLocale()}
    />
  );
}
