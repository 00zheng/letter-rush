import type { MetadataRoute } from "next";

import { getApplicationUrl } from "@/lib/app-url";

export default function manifest(): MetadataRoute.Manifest {
  const applicationUrl = getApplicationUrl();

  return {
    id: applicationUrl.toString(),
    name: "Letter Rush Word Grid",
    short_name: "Letter Rush",
    description:
      "Swipe through a fast, deterministic word grid alone or with a private lobby.",
    start_url: applicationUrl.toString(),
    scope: applicationUrl.toString(),
    display: "standalone",
    background_color: "#f1eadb",
    theme_color: "#ff6b35",
    orientation: "any",
    icons: [
      {
        src: new URL("/icons/icon.svg", applicationUrl).toString(),
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: new URL("/icons/icon-maskable.svg", applicationUrl).toString(),
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
