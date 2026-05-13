#!/usr/bin/env node
const net = require("node:net");

const listenHost = process.env.SWARMFLEET_TLS_MUX_HOST || "0.0.0.0";
const listenPort = Number.parseInt(process.env.SWARMFLEET_TLS_MUX_PORT || "443", 10);
const targetHost = process.env.SWARMFLEET_CADDY_HTTPS_HOST || "127.0.0.1";
const targetPort = Number.parseInt(process.env.SWARMFLEET_CADDY_HTTPS_PORT || "7443", 10);
const publicPort = process.env.SWARMFLEET_PUBLIC_PORT || "7070";
const maxHeaderBytes = 16 * 1024;

const HTTP_METHODS = [
  "GET ",
  "POST ",
  "HEAD ",
  "PUT ",
  "PATCH ",
  "DELETE ",
  "OPTIONS ",
  "TRACE ",
  "CONNECT ",
  "PRI ",
];

function looksLikeHttp(chunk) {
  const prefix = chunk.subarray(0, 8).toString("ascii");
  return HTTP_METHODS.some((method) => prefix.startsWith(method));
}

function hostHasPort(host) {
  if (host.startsWith("[")) return host.includes("]:");
  return /:\d+$/.test(host);
}

function redirectHost(host) {
  const trimmed = host.trim();
  if (!trimmed || hostHasPort(trimmed) || publicPort === "443") return trimmed;
  return `${trimmed}:${publicPort}`;
}

function pathFromRequestTarget(target) {
  if (!target) return "/";
  if (target.startsWith("/")) return target;
  try {
    const url = new URL(target);
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function sendRedirect(client, requestText) {
  const [requestLine = "", ...headerLines] = requestText.split(/\r?\n/);
  const [, target = "/"] = requestLine.match(/^\S+\s+(\S+)/) || [];
  const hostLine = headerLines.find((line) => /^host:/i.test(line));
  const host = hostLine ? hostLine.slice(hostLine.indexOf(":") + 1).trim() : "";
  const locationHost = redirectHost(host) || `localhost:${publicPort}`;
  const location = `https://${locationHost}${pathFromRequestTarget(target)}`;
  const body = `Redirecting to ${location}\n`;

  client.end(
    [
      "HTTP/1.1 308 Permanent Redirect",
      `Location: ${location}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
}

function proxyTls(client, firstChunk) {
  client.pause();
  const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
    upstream.write(firstChunk);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });

  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };

  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
}

const server = net.createServer((client) => {
  client.once("data", (firstChunk) => {
    if (!looksLikeHttp(firstChunk)) {
      proxyTls(client, firstChunk);
      return;
    }

    const chunks = [firstChunk];
    let totalBytes = firstChunk.length;
    let text = Buffer.concat(chunks, totalBytes).toString("latin1");
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      sendRedirect(client, text);
    };
    const timer = setTimeout(finish, 1000);

    if (text.includes("\r\n\r\n") || text.includes("\n\n")) {
      clearTimeout(timer);
      finish();
      return;
    }

    client.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      text = Buffer.concat(chunks, totalBytes).toString("latin1");

      if (
        totalBytes >= maxHeaderBytes ||
        text.includes("\r\n\r\n") ||
        text.includes("\n\n")
      ) {
        clearTimeout(timer);
        finish();
      }
    });
  });
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `[http-https-mux] listening on ${listenHost}:${listenPort}, forwarding TLS to ${targetHost}:${targetPort}`,
  );
});
