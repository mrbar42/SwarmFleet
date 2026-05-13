import type { Context, Hono } from "hono";
import type { ConfigContext } from "../../middleware/config.ts";
import {
  previewService,
  type PreviewStatus,
} from "../../services/previewService.ts";
import {
  getWorkspacesRootFromContext,
  ProjectPathError,
  projectPathErrorResponse,
  validateExistingProjectPath,
} from "../../utils/projectPaths.ts";

function projectPathFromQuery(c: Context): string | null {
  return c.req.query("project") ?? null;
}

async function projectPathFromBody(c: Context): Promise<string | null> {
  const body = await c.req
    .json<{ projectPath?: string }>()
    .catch(() => ({}) as { projectPath?: string });
  return typeof body.projectPath === "string" ? body.projectPath : null;
}

async function validateProjectPath(
  c: Context<ConfigContext>,
  projectPath: string | null,
): Promise<string | Response> {
  try {
    return await validateExistingProjectPath(
      projectPath,
      getWorkspacesRootFromContext(c),
    );
  } catch (error) {
    if (error instanceof ProjectPathError) return projectPathErrorResponse(error);
    throw error;
  }
}

function proxyTargetPath(requestUrl: string, previewId: string): string {
  const url = new URL(requestUrl);
  const prefix = `/api/preview/proxy/${previewId}`;
  let path = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return `${path}${url.search}`;
}

function directPreviewUrl(c: Context, status: PreviewStatus): string | null {
  if (status.state !== "running" || status.port === null) return null;
  if (process.env.SWARMFLEET_PREVIEW_URL_MODE !== "direct") return status.url;

  const requestUrl = new URL(c.req.url);
  const protocol = (
    process.env.SWARMFLEET_PREVIEW_PUBLIC_PROTOCOL ?? "http"
  ).replace(/:$/, "");
  const hostname =
    process.env.SWARMFLEET_PREVIEW_PUBLIC_HOST ?? requestUrl.hostname;
  const url = new URL(`${protocol}://preview.local/`);
  url.hostname = hostname;
  url.port = String(status.port);
  return url.toString();
}

function publicPreviewStatus(c: Context, status: PreviewStatus): PreviewStatus {
  return {
    ...status,
    url: directPreviewUrl(c, status),
  };
}

function previewProxyPrefix(previewId: string): string {
  return `/api/preview/proxy/${encodeURIComponent(previewId)}`;
}

function shouldRewriteResponse(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/html") ||
    normalized.includes("text/css") ||
    normalized.includes("javascript") ||
    normalized.includes("application/json") ||
    normalized.includes("image/svg+xml")
  );
}

function proxyRootPath(prefix: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (path.startsWith(prefix)) return path;
  return `${prefix}${path}`;
}

function rewriteSrcSet(prefix: string, value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const trimmedStart = candidate.match(/^\s*/)?.[0] ?? "";
      const trimmed = candidate.trimStart();
      if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
        return candidate;
      }
      return `${trimmedStart}${proxyRootPath(prefix, trimmed)}`;
    })
    .join(",");
}

function rewritePreviewBody(
  body: string,
  previewId: string,
  contentType: string | null,
): string {
  const prefix = previewProxyPrefix(previewId);
  const normalized = contentType?.toLowerCase() ?? "";
  let rewritten = body;

  if (
    normalized.includes("text/html") ||
    normalized.includes("image/svg+xml")
  ) {
    rewritten = rewritten.replace(
      /\b(src|href|action|poster)=("|')\/(?!\/)([^"']*)\2/gi,
      (_match, attr: string, quote: string, path: string) =>
        `${attr}=${quote}${proxyRootPath(prefix, `/${path}`)}${quote}`,
    );
    rewritten = rewritten.replace(
      /\bsrcset=("|')([^"']*)\1/gi,
      (_match, quote: string, value: string) =>
        `srcset=${quote}${rewriteSrcSet(prefix, value)}${quote}`,
    );
  }

  rewritten = rewritten.replace(
    /url\((["']?)\/(?!\/)([^)"']+)\1\)/gi,
    (_match, quote: string, path: string) =>
      `url(${quote}${proxyRootPath(prefix, `/${path}`)}${quote})`,
  );

  if (
    normalized.includes("javascript") ||
    normalized.includes("application/json") ||
    normalized.includes("text/html")
  ) {
    rewritten = rewritten.replace(
      /(["'`])\/(?!\/)([^"'`\s)<>]+)\1/g,
      (match, quote: string, path: string) => {
        if (path.startsWith("api/preview/proxy/")) return match;
        return `${quote}${proxyRootPath(prefix, `/${path}`)}${quote}`;
      },
    );
  }

  return rewritten;
}

async function proxyPreviewRequest(c: Context): Promise<Response> {
  const previewId = c.req.param("previewId");
  if (!previewId) return c.text("Preview id is required", 400);
  const status = previewService.getById(previewId);
  if (!status || status.state !== "running" || status.port === null) {
    return c.text("Preview is not running", 502);
  }

  const targetUrl = `http://127.0.0.1:${status.port}${proxyTargetPath(
    c.req.url,
    previewId,
  )}`;

  const headers = new Headers(c.req.raw.headers);
  headers.set("host", `127.0.0.1:${status.port}`);
  headers.delete("accept-encoding");
  headers.set("x-forwarded-host", new URL(c.req.url).host);
  headers.set(
    "x-forwarded-proto",
    new URL(c.req.url).protocol.replace(":", ""),
  );

  const proxyInit: RequestInit & { duplex?: "half" } = {
    method: c.req.method,
    headers,
    redirect: "manual",
  };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    proxyInit.body = c.req.raw.body;
    proxyInit.duplex = "half";
  }

  const response = await fetch(targetUrl, proxyInit);

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");

  const location = responseHeaders.get("location");
  if (location) {
    try {
      const parsed = new URL(location, targetUrl);
      if (parsed.host === `127.0.0.1:${status.port}`) {
        responseHeaders.set(
          "location",
          `${previewProxyPrefix(previewId)}${parsed.pathname}${parsed.search}${parsed.hash}`,
        );
      }
    } catch {
      // keep original location
    }
  }

  const contentType = responseHeaders.get("content-type");
  if (
    c.req.method !== "HEAD" &&
    response.body &&
    shouldRewriteResponse(contentType)
  ) {
    const body = rewritePreviewBody(
      await response.text(),
      previewId,
      contentType,
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function registerPreviewRoutes(app: Hono<ConfigContext>): void {
  app.get("/api/preview/status", async (c) => {
    const projectPath = await validateProjectPath(c, projectPathFromQuery(c));
    if (projectPath instanceof Response) return projectPath;
    return c.json(
      publicPreviewStatus(c, await previewService.status(projectPath)),
    );
  });

  app.patch("/api/preview/config", async (c) => {
    const body = await c.req
      .json<{
        projectPath?: string;
        command?: string;
        publishToHost?: boolean;
      }>()
      .catch(
        () =>
          ({}) as {
            projectPath?: string;
            command?: string;
            publishToHost?: boolean;
          },
      );
    const projectPath = await validateProjectPath(c, body.projectPath ?? null);
    if (projectPath instanceof Response) return projectPath;
    return c.json(
      publicPreviewStatus(
        c,
        await previewService.configure(projectPath, body.command ?? "auto", {
          publishToHost: body.publishToHost,
        }),
      ),
    );
  });

  app.post("/api/preview/start", async (c) => {
    const projectPath = await validateProjectPath(c, await projectPathFromBody(c));
    if (projectPath instanceof Response) return projectPath;
    return c.json(
      publicPreviewStatus(c, await previewService.start(projectPath)),
    );
  });

  app.post("/api/preview/restart", async (c) => {
    const projectPath = await validateProjectPath(c, await projectPathFromBody(c));
    if (projectPath instanceof Response) return projectPath;
    return c.json(
      publicPreviewStatus(c, await previewService.restart(projectPath)),
    );
  });

  app.post("/api/preview/stop", async (c) => {
    const projectPath = await validateProjectPath(c, await projectPathFromBody(c));
    if (projectPath instanceof Response) return projectPath;
    return c.json(
      publicPreviewStatus(c, await previewService.stop(projectPath)),
    );
  });

  app.all("/api/preview/proxy/:previewId", proxyPreviewRequest);
  app.all("/api/preview/proxy/:previewId/*", proxyPreviewRequest);
}
