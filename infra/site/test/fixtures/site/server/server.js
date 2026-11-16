// Fixture Worker entry for infra/site checks (no site build needed): answers the routes the smoke
// test expects from the real Worker script. Not deployed.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") return Response.json([]);
    if (url.pathname === "/llms.txt") return new Response("# fixture\n\n- /docs\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
