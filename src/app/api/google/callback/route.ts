import { completeSignIn } from "@/lib/google";

// Google sends the browser back here after consent.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const home = new URL("/", request.url);
  try {
    const denied = url.searchParams.get("error");
    if (denied) throw new Error(`Google sign-in was cancelled (${denied})`);
    await completeSignIn(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", url.origin);
  } catch (err) {
    home.searchParams.set("google_error", (err as Error).message);
  }
  return Response.redirect(home);
}
