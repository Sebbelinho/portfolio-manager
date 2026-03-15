// Cloudflare Worker: FRED API CORS Proxy
// Deploy: https://workers.cloudflare.com → Create Worker → paste this code
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/fred") {
      return new Response("Not found", { status: 404 });
    }
    const params = url.searchParams.toString();
    if (!params) {
      return new Response("Missing query params", { status: 400 });
    }
    const fredUrl = `https://api.stlouisfed.org/fred/series/observations?${params}`;
    try {
      const resp = await fetch(fredUrl);
      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
