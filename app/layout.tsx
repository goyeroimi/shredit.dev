import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getRequestLocale } from "@/lib/request-locale";
import { getRequestTheme } from "@/lib/request-theme";
import { SITE_ORIGIN } from "@/lib/site";
import { ThemeProvider } from "@/lib/theme-provider";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: "Shredit - Encrypted one-time notes",
    template: "%s - Shredit",
  },
  description:
    "Create an encrypted one-time plain text note, share the link once, and let the server discard the ciphertext after the first explicit open. No account, no tracking.",
  applicationName: "Shredit",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon", sizes: "16x16 32x32 48x48" },
      { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
    ],
    shortcut: "/favicon.ico",
    apple: [
      {
        url: "/apple-icon.png",
        type: "image/png",
        sizes: "180x180",
      },
    ],
  },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Shredit",
    locale: "en_US",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  initialScale: 1,
  viewportFit: "cover",
  width: "device-width",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [locale, theme] = await Promise.all([
    getRequestLocale(),
    getRequestTheme(),
  ]);
  return (
    <html lang={locale} data-theme={theme}>
      <body>
        <ThemeProvider initialTheme={theme}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
