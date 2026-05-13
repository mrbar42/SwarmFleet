import type { PreviewStatus } from "@shared/types";

export function installPreviewNavigationGuard(
  iframe: HTMLIFrameElement | null,
  status: PreviewStatus | null,
): void {
  if (!iframe || !status?.id) return;

  let frameWindow: Window;
  let frameDocument: Document;
  try {
    if (!iframe.contentWindow || !iframe.contentDocument) return;
    frameWindow = iframe.contentWindow;
    frameDocument = iframe.contentDocument;
  } catch {
    return;
  }

  const marker = "__swarmfleetPreviewNavigationGuard";
  if ((frameWindow as unknown as Record<string, unknown>)[marker]) return;
  (frameWindow as unknown as Record<string, unknown>)[marker] = true;

  const proxyPrefix = `/api/preview/proxy/${encodeURIComponent(status.id)}`;
  type HistoryUrl = string | URL | null | undefined;

  const proxify = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    let url: URL;
    try {
      url = new URL(String(value), frameWindow.location.href);
    } catch {
      return value;
    }

    if (url.origin !== window.location.origin) return value;
    if (url.pathname.startsWith(proxyPrefix)) return value;
    if (url.pathname.startsWith("/api/")) return value;
    return `${proxyPrefix}${url.pathname}${url.search}${url.hash}`;
  };

  const wrapHistoryMethod = (
    method: "pushState" | "replaceState",
  ): void => {
    const original = frameWindow.history[method];
    frameWindow.history[method] = function (
      data: unknown,
      unused: string,
      url?: HistoryUrl,
    ) {
      return original.call(
        this,
        data,
        unused,
        proxify(url) as HistoryUrl,
      );
    };
  };

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");

  frameDocument.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof frameWindow.Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof frameWindow.HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;

      const next = proxify(anchor.href);
      if (next === anchor.href) return;

      event.preventDefault();
      frameWindow.location.href = String(next);
    },
    false,
  );
}
