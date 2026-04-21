/*
 * Academy Reporting Worker
 * ------------------------
 * Tiny Cloudflare Worker that receives course-completion events from the
 * academy's static HTML page and writes them to a Notion database.
 *
 * HOW TO DEPLOY (5 minutes)
 *
 * 1. Create a Notion integration
 *    - Go to https://www.notion.so/my-integrations and click "New integration".
 *    - Give it a name (e.g. "Academy Reporter") and copy the "Internal Integration Secret".
 *
 * 2. Create a Notion database with EXACTLY these properties and types:
 *    - "Learner"     (Title)
 *    - "Email"       (Email)
 *    - "Company"     (Text)
 *    - "Role"        (Select)    — options: "Planner / Dispatcher", "Manager / Admin", "Driver"
 *    - "Course"      (Text)
 *    - "Course ID"   (Text)
 *    - "Completed"   (Date)
 *    (Notion will auto-create any missing select options on first write.)
 *    Then click the "..." menu on the database -> Connections -> add your integration.
 *    Copy the database ID from the URL: notion.so/<workspace>/<DB_ID>?v=...
 *    (The DB_ID is the 32-char hash before the "?".)
 *
 * 3. Deploy this Worker
 *    - Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Hello World.
 *    - Replace the default code with the contents of this file, click "Deploy".
 *    - In the Worker's Settings -> Variables, add two SECRETS:
 *         NOTION_TOKEN        = <your integration secret>
 *         NOTION_DATABASE_ID  = <your database id>
 *    - Settings -> Triggers -> note the *.workers.dev URL.
 *
 * 4. Wire the URL into index.html
 *    - Open index.html, find REPORTING_ENDPOINT at the top of <script>, paste the URL.
 *    - Reload the page, complete a course, check the Notion database.
 */

const ALLOW_ORIGIN = "*"; // tighten to your domain once you deploy the site

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: "invalid JSON" }, 400); }

    // Basic validation
    const { event, learner, course, completedAt, roleLabel } = payload || {};
    if (event !== "course_completed") return json({ error: "unknown event" }, 400);
    if (!learner?.name || !learner?.email || !learner?.company) {
      return json({ error: "learner missing fields" }, 400);
    }
    if (!course?.id || !course?.title) return json({ error: "course missing fields" }, 400);

    const properties = {
      "Learner":   { title: [{ text: { content: String(learner.name).slice(0, 200) } }] },
      "Email":     { email: String(learner.email).slice(0, 200) },
      "Company":   { rich_text: [{ text: { content: String(learner.company).slice(0, 200) } }] },
      "Course":    { rich_text: [{ text: { content: String(course.title).slice(0, 200) } }] },
      "Course ID": { rich_text: [{ text: { content: String(course.id).slice(0, 200) } }] },
      "Completed": { date: { start: completedAt || new Date().toISOString() } },
    };

    // Only include Role if the client sent one — keeps the Worker backwards-compatible
    // with older page versions that don't send roleLabel.
    if (roleLabel) {
      properties["Role"] = { select: { name: String(roleLabel).slice(0, 100) } };
    }

    const body = {
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("notion error", res.status, text);
      return json({ error: "notion rejected", status: res.status, detail: text }, 502);
    }
    return json({ ok: true });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
