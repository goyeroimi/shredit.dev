import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Abuse contact",
  description:
    "How to report abuse of Shredit without sending note contents, passwords, or decryption keys.",
  alternates: { canonical: "/abuse" },
};
export default async function Page() {
  return (
    <LegalPage
      kind="abuse"
      publicConfig={getPublicRuntimeConfig()}
      initialLocale={await getRequestLocale()}
    />
  );
}
