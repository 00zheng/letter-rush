import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Letter Rush Word Grid",
    short_name: "Letter Rush",
    description:
      "Swipe through a fast, deterministic word grid alone or with a private lobby.",
    start_url: "/",
    display: "standalone",
    background_color: "#f1eadb",
    theme_color: "#ff6b35",
    orientation: "any",
    icons: [
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
