import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy · Outreach",
  description: "How Outreach uses Google account data.",
};

// The public privacy policy Google asks for before an OAuth app can go to production.
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-ink">
      <Link href="/" className="text-sm font-semibold text-primary hover:underline">
        ← Outreach
      </Link>
      <h1 className="mt-6 font-serif text-5xl tracking-tight">Privacy policy</h1>
      <p className="mt-2 text-sm text-ink/60">Last updated 24 November 2026</p>

      <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-ink/80">
        <section>
          <h2 className="font-serif text-2xl text-ink">What Outreach is</h2>
          <p className="mt-2">
            Outreach is a sales prospecting tool used by its owner. It finds companies that match an ideal customer profile, drafts outreach emails for a person
            to review, sends the emails the user approves, and helps book meetings with prospects who reply.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-2xl text-ink">Google data we access</h2>
          <p className="mt-2">When you connect your Google account, Outreach asks for these permissions and uses them only for the purpose shown:</p>
          <ul className="mt-3 list-disc space-y-2 pl-6">
            <li>
              <strong>Send email (gmail.send):</strong> to send the outreach and follow-up emails you approve, from your own Gmail address.
            </li>
            <li>
              <strong>Read email (gmail.readonly):</strong> to read replies in the email threads Outreach started, so it can tell you when a prospect answers. It does
              not read other emails.
            </li>
            <li>
              <strong>Calendar events (calendar.events):</strong> to check whether a time is free and to add meetings that a prospect agrees to, with a meeting link.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-serif text-2xl text-ink">How it is stored</h2>
          <p className="mt-2">
            Outreach stores a sign-in token for your Google account, the email threads it started, and the replies to them, in its own database. Data is sent
            over encrypted connections. Prospect research and email drafts are processed with Google Gemini.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-2xl text-ink">What we do not do</h2>
          <ul className="mt-2 list-disc space-y-2 pl-6">
            <li>We do not sell or share your Google data with anyone.</li>
            <li>We do not use your Google data for advertising.</li>
            <li>We do not use your Google data to train AI models.</li>
          </ul>
          <p className="mt-3">
            Outreach&apos;s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-2xl text-ink">Removing access and data</h2>
          <p className="mt-2">
            You can disconnect Outreach at any time from your Google account at myaccount.google.com/permissions. Once disconnected, Outreach can no longer send,
            read or book anything. To have the stored data deleted, contact the app owner using the support email shown on Google&apos;s sign-in screen.
          </p>
        </section>
      </div>
    </main>
  );
}
