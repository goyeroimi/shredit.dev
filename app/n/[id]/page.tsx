import type { Metadata } from "next";
import NotePageClient from "@/components/note-page-client";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";

export const metadata: Metadata = {
  title: "One-time note",
  description: "A private one-time note. Opening it destroys it.",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
  },
};

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function NotePage() {
  return (
    <NotePageClient
      publicConfig={getPublicRuntimeConfig()}
      initialLocale={await getRequestLocale()}
    />
  );
}
