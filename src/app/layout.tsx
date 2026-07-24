import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { getApplicationUrl } from "@/lib/app-url";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const applicationUrl = getApplicationUrl();

export const metadata: Metadata = {
  metadataBase: applicationUrl,
  title: "Letter Rush - word-grid sprint",
  description:
    "Connect neighboring letters, build words, and race the clock in Letter Rush.",
  applicationName: "Letter Rush",
  manifest: "/manifest.webmanifest",
  alternates: {
    canonical: applicationUrl,
  },
  openGraph: {
    type: "website",
    url: applicationUrl,
    siteName: "Letter Rush",
    title: "Letter Rush - word-grid sprint",
    description:
      "Connect neighboring letters, build words, and race the clock in Letter Rush.",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Letter Rush",
  },
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ff6b35",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
