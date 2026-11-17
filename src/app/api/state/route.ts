import { connection } from "next/server";
import { respond } from "@/lib/respond";

export async function GET() {
  await connection();
  return respond();
}
