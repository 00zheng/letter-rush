import { DICTIONARY_METADATA } from "@/game/dictionary";

export const dynamic = "force-static";

export function GET() {
  return Response.json(
    {
      version: DICTIONARY_METADATA.version,
      wordCount: DICTIONARY_METADATA.wordCount,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=3600",
      },
    },
  );
}
