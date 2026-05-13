import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { SettingsContext } from "../contexts/SettingsContextTypes";
import {
  getUnreadSessions,
  subscribeUnreadSessions,
} from "../stores/unreadSessions";

let originalHref: string | null = null;
let flippedHrefPromise: Promise<string | null> | null = null;
const MANAGED_FAVICON_ATTR = "data-swarmfleet-unread-favicon";
const ORIGINAL_HREF_ATTR = "data-swarmfleet-original-href";
const ORIGINAL_TYPE_ATTR = "data-swarmfleet-original-type";
const UNREAD_FAVICON_SOURCE = "/icon.png";

function getUnreadCount(): number {
  return getUnreadSessions().size;
}

function isPageVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function getBaseFaviconLinks(): HTMLLinkElement[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>(
      `link[rel~="icon"]:not([${MANAGED_FAVICON_ATTR}])`,
    ),
  );
}

function getOrCreateBaseFaviconLink(): HTMLLinkElement | null {
  const existing = getBaseFaviconLinks()[0];
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = "/favicon.ico";
  document.head.appendChild(link);
  return link;
}

function captureOriginalHref(): string {
  const link = getOrCreateBaseFaviconLink();
  if (!link) return "/favicon.ico";

  for (const faviconLink of getBaseFaviconLinks()) {
    if (!faviconLink.hasAttribute(ORIGINAL_HREF_ATTR)) {
      faviconLink.setAttribute(
        ORIGINAL_HREF_ATTR,
        faviconLink.getAttribute("href") || faviconLink.href || "/favicon.ico",
      );
    }
    if (!faviconLink.hasAttribute(ORIGINAL_TYPE_ATTR)) {
      faviconLink.setAttribute(
        ORIGINAL_TYPE_ATTR,
        faviconLink.getAttribute("type") || "",
      );
    }
  }

  const href =
    link.getAttribute(ORIGINAL_HREF_ATTR) ||
    link.getAttribute("href") ||
    link.href;
  // Older builds mutated the original link to a data URL. Recover to the app's
  // shipped favicon if that is the only "original" we can observe.
  return href.startsWith("data:") ? "/favicon.ico" : href;
}

function resolveHref(href: string): string {
  return new URL(href, window.location.href).href;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function createFlippedFavicon(): Promise<string | null> {
  try {
    const image = await loadImage(resolveHref(UNREAD_FAVICON_SOURCE));
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;

    context.translate(size / 2, size / 2);
    context.rotate(Math.PI);
    const scale = Math.min(
      size / image.naturalWidth,
      size / image.naturalHeight,
    );
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, -width / 2, -height / 2, width, height);

    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function applyUnreadFavicon(href: string): void {
  for (const link of getBaseFaviconLinks()) {
    link.href = href;
    link.type = "image/png";
  }

  const managed =
    document.querySelector<HTMLLinkElement>(`link[${MANAGED_FAVICON_ATTR}]`) ??
    document.createElement("link");
  managed.rel = "icon";
  managed.type = "image/png";
  managed.href = href;
  managed.setAttribute(MANAGED_FAVICON_ATTR, "true");
  if (!managed.parentElement) {
    document.head.appendChild(managed);
  }
}

function restoreFavicon(): void {
  document
    .querySelectorAll<HTMLLinkElement>(`link[${MANAGED_FAVICON_ATTR}]`)
    .forEach((link) => link.remove());

  for (const link of getBaseFaviconLinks()) {
    const storedHref = link.getAttribute(ORIGINAL_HREF_ATTR);
    const storedType = link.getAttribute(ORIGINAL_TYPE_ATTR);
    if (storedHref && !storedHref.startsWith("data:")) {
      link.href = storedHref;
    } else if (link.href.startsWith("data:")) {
      link.href = "/favicon.ico";
    }
    if (storedType) {
      link.type = storedType;
    } else {
      link.removeAttribute("type");
    }
  }
}

export function FaviconUnreadIndicator() {
  const unreadCount = useSyncExternalStore(
    subscribeUnreadSessions,
    getUnreadCount,
  );
  const settingsCtx = useContext(SettingsContext);
  const enabled = settingsCtx?.settings.flipFaviconOnUnread ?? true;
  const [pageVisible, setPageVisible] = useState(isPageVisible);

  useEffect(() => {
    const updatePageVisible = () => setPageVisible(isPageVisible());
    document.addEventListener("visibilitychange", updatePageVisible);
    window.addEventListener("pageshow", updatePageVisible);
    updatePageVisible();
    return () => {
      document.removeEventListener("visibilitychange", updatePageVisible);
      window.removeEventListener("pageshow", updatePageVisible);
    };
  }, []);

  useEffect(() => {
    if (!originalHref) {
      originalHref = captureOriginalHref();
    }

    if (!enabled || unreadCount === 0 || pageVisible) {
      restoreFavicon();
      return;
    }

    if (!flippedHrefPromise) {
      flippedHrefPromise = createFlippedFavicon();
    }

    let cancelled = false;
    void flippedHrefPromise.then((flippedHref) => {
      if (cancelled || !flippedHref) return;
      applyUnreadFavicon(flippedHref);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, pageVisible, unreadCount]);

  return null;
}
