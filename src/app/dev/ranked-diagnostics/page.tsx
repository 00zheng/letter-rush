import { notFound } from "next/navigation";

import { RankedDiagnostics } from "@/components/ranked-diagnostics";

export default function RankedDiagnosticsPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <RankedDiagnostics />;
}
