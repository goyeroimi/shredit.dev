import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How Shredit handles notes: AES-256-GCM encryption in the browser, the key stays in the URL fragment, one-time ciphertext storage, and no trackers.",
  alternates: { canonical: "/privacy" },
};
export default async function Page() {
  return (
    <LegalPage
      kind="privacy"
      publicConfig={getPublicRuntimeConfig()}
      initialLocale={await getRequestLocale()}
    />
  );
}
