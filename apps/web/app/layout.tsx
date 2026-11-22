import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const dmSans = localFont({
  src: "./fonts/DM_Sans.woff2",
  weight: "400 500",
  display: "swap",
  variable: "--font-dm-sans",
});

const archivo = localFont({
  src: "./fonts/Archivo.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  title: "Mimir",
  description:
    "Mimir is one continuous AI assistant. Tell it something once; it watches your Gmail, Calendar, Notion, Linear, GitHub and Slack and only interrupts when it matters.",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${archivo.variable}`}>
      <body style={{ backgroundColor: "oklch(0.145 0.004 285)" }}>{children}</body>
    </html>
  );
}
