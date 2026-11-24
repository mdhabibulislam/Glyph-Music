import { json } from "@/lib/server/guard";
import { isConfigured } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// Public. Tells the login page which screen to show. "cloud" means the site runs on its
// own (no PC backend) and the access code comes from an environment variable.
export async function GET() {
  return json(200, { configured: isConfigured(), mode: "cloud" });
}
