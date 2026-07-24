import type { MetadataRoute } from "next";

import { getApplicationUrl } from "@/lib/app-url";

export default function manifest(): MetadataRoute.Manifest {
  const applicationUrl = getApplicationUrl();

  return {
    id: applicationUrl.toString(),
    name: "Letter Rush Word Grid",
    short_name: "Letter Rush",
    description:
      "Swipe through a deterministic word grid in local, private, or ranked play.",
    start_url: applicationUrl.toString(),
    scope: applicationUrl.toString(),
    display: "standalone",
    background_color: "#f1eadb",
    theme_color: "#ff6b35",
    orientation: "any",
    shortcuts: [
      {
        name: "Ranked Quick Match",
        short_name: "Quick Match",
        description: "Find one opponent for a fixed 60-second ranked round.",
        url: new URL("/quick-match", applicationUrl).toString(),
      },
      {
        name: "Ranked Leaderboards",
        short_name: "Leaderboards",
        description: "View all-time Letter Rush rankings.",
        url: new URL("/leaderboards", applicationUrl).toString(),
      },
    ],
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
