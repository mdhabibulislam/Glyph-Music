import { json } from "@/lib/server/guard";

export const dynamic = "force-dynamic";

// Vercel has nowhere to store a code created on the website, so in this mode the code
// can only come from the ADMIN_ACCESS_CODE environment variable. Nobody can set it here.
export async function POST() {
  return json(409, {
    error: "On Vercel the access code is set with the ADMIN_ACCESS_CODE environment variable.",
    code: "env_required",
  });
}
