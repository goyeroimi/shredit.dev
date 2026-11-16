import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/privacy", "/security", "/terms", "/abuse", "/changelog"].map(
    (path) => ({
      url: `${SITE_ORIGIN}${path}`,
      changeFrequency: "monthly",
      priority: path === "/" ? 1 : 0.6,
    }),
  );
}
