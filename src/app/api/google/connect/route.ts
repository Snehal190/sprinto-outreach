import { connection } from "next/server";
import { consentUrl } from "@/lib/google";

// Starts the Google sign-in: sends the browser to Google's consent screen.
export async function GET(request: Request) {
  await connection();
  try {
    return Response.redirect(await consentUrl(new URL(request.url).origin));
  } catch (err) {
    return Response.redirect(new URL(`/?google_error=${encodeURIComponent((err as Error).message)}`, request.url));
  }
}
