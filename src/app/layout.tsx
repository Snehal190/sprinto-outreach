import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Outreach",
  description: "ICP-driven prospecting funnel: shortlist, find the POC, draft, review and send.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${manrope.variable} ${instrumentSerif.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <footer className="pb-8 pt-4 text-center text-xs text-ink/50">
          <Link href="/privacy" className="hover:text-primary hover:underline">
            Privacy policy
          </Link>
        </footer>
      </body>
    </html>
  );
}
