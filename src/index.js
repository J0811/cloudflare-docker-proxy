addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const CUSTOM_DOMAIN = globalThis.CUSTOM_DOMAIN || "nutramines.com";
const MODE = globalThis.MODE || "production";
const TARGET_UPSTREAM = globalThis.TARGET_UPSTREAM || "";
const dockerHub = "https://registry-1.docker.io";

// 动态生成路由表
const routes = new Map(Object.entries({
  [`docker.${CUSTOM_DOMAIN}`]: dockerHub,
  [`quay.${CUSTOM_DOMAIN}`]: "https://quay.io",
  [`gcr.${CUSTOM_DOMAIN}`]: "https://gcr.io",
  [`k8s-gcr.${CUSTOM_DOMAIN}`]: "https://k8s.gcr.io",
  [`k8s.${CUSTOM_DOMAIN}`]: "https://registry.k8s.io",
  [`ghcr.${CUSTOM_DOMAIN}`]: "https://ghcr.io",
  [`cloudsmith.${CUSTOM_DOMAIN}`]: "https://docker.cloudsmith.io",
  [`ecr.${CUSTOM_DOMAIN}`]: "https://public.ecr.aws",
  [`docker-staging.${CUSTOM_DOMAIN}`]: dockerHub,
}));

// 路由匹配逻辑
function routeByHosts(host) {
  return routes.get(host) || (MODE === "debug" ? TARGET_UPSTREAM : "");
}

// 主处理函数
async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = routeByHosts(url.hostname);

  if (!upstream) {
    return new Response(
      JSON.stringify({ error: "No route found", routes: Object.fromEntries(routes) }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // Redirect to /help.html for root requests
  if (url.pathname === "/") {
    return Response.redirect(`${url.origin}/help.html`, 301);
  }

  const isDockerHub = upstream === dockerHub;
  const authorization = request.headers.get("Authorization");

  // DockerHub authentication
  if (url.pathname === "/v2/") {
    const newUrl = new URL(`${upstream}/v2/`);
    const resp = await fetchWithHeaders(newUrl.toString(), "GET", authorization ? { Authorization: authorization } : {});

    if (resp.status === 401) {
      return responseUnauthorized(url);
    }
    return resp;
  }

  // Token fetching
  if (url.pathname === "/v2/auth") {
    const newUrl = new URL(`${upstream}/v2/`);
    const resp = await fetch(newUrl.toString(), { method: "GET", redirect: "follow" });

    if (resp.status !== 401) return resp;

    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (!authenticateStr) return resp;

    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");

    // Autocomplete DockerHub library images
    if (scope && isDockerHub) {
      const scopeParts = scope.split(":");
      if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = `library/${scopeParts[1]}`;
        scope = scopeParts.join(":");
      }
    }

    return await fetchToken(wwwAuthenticate, scope, authorization);
  }

  // Redirect DockerHub library images
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length === 5 && !pathParts[2].includes("library")) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl, 301);
    }
  }

  // Forward other requests
  const newUrl = new URL(`${upstream}${url.pathname}`);
  const newReq = new Request(newUrl, { method: request.method, headers: request.headers, redirect: "follow" });
  const resp = await fetch(newReq);

  if (resp.status === 401) {
    return responseUnauthorized(url);
  }
  return resp;
}

// 解析 WWW-Authenticate 头
function parseAuthenticate(authenticateStr) {
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (!matches || matches.length < 2) {
    console.error(`Invalid WWW-Authenticate header: ${authenticateStr}`);
    return null;
  }
  return { realm: matches[0], service: matches[1] };
}

// 获取 Token
async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url.toString(), { method: "GET", headers });
}

// 构建 401 响应
function responseUnauthorized(url) {
  const headers = new Headers();
  const realm = MODE === "debug"
    ? `http://${url.host}/v2/auth`
    : `https://${url.hostname}/v2/auth`;

  headers.set("Www-Authenticate", `Bearer realm="${realm}",service="cloudflare-docker-proxy"`);
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers,
  });
}

// 封装 fetchWithHeaders
async function fetchWithHeaders(url, method = "GET", headers = {}, redirect = "follow") {
  return await fetch(url, { method, headers: new Headers(headers), redirect });
}
