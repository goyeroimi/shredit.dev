import type { Metadata } from "next";
import { headers } from "next/headers";
import HomePage from "@/components/home-page";
import { getPublicRuntimeConfig } from "@/lib/public-config";
import { getRequestLocale } from "@/lib/request-locale";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Shredit",
    locale: "en_US",
    url: "/",
    title: "Shredit - Encrypted one-time notes",
    description:
      "Create an encrypted one-time plain text note, share the link once, and let the server discard the ciphertext after the first explicit open. No account, no tracking.",
    images: [
      {
        url: "/icon-512.png",
        width: 512,
        height: 512,
        alt: "Shredit mark",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Shredit - Encrypted one-time notes",
    description:
      "Create an encrypted one-time plain text note, share the link once, and let the server discard the ciphertext after the first explicit open.",
    images: ["/icon-512.png"],
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://shredit.dev/#website",
      url: "https://shredit.dev/",
      name: "Shredit",
      description:
        "Encrypted one-time plain text notes with a decryption key that stays in the URL fragment.",
      inLanguage: "en",
    },
    {
      "@type": "WebApplication",
      "@id": "https://shredit.dev/#application",
      name: "Shredit",
      url: "https://shredit.dev/",
      applicationCategory: "SecurityApplication",
      operatingSystem: "Any",
      browserRequirements: "JavaScript and Web Crypto (AES-256-GCM)",
      description:
        "Create an encrypted one-time plain text note, share the link once, and let the server discard the ciphertext after the first explicit open.",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
    },
  ],
};

export default async function Page() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</gu, "\\u003c"),
        }}
      />
      <HomePage
        publicConfig={getPublicRuntimeConfig()}
        initialLocale={await getRequestLocale()}
      />
    </>
  );
}
