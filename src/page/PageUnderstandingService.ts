/**
 * PageUnderstandingService: Lens-style "what's on screen" analysis.
 *
 * DOM-first approach:
 *   1. Extract clickable/input elements from the live DOM via PlaywrightDriver
 *   2. Detect blocking alerts (modals, cookie banners, captcha)
 *   3. Classify the page_type from URL + title + element patterns
 *   4. Hash the result for change detection
 *
 * OCR is NOT used by default; the DOM extraction is sufficient for most pages.
 * For canvas-only UIs, callers can provide a screenshot buffer and OCR separately.
 */

import { createHash } from "node:crypto";
import type { PlaywrightDriver } from "../browser/PlaywrightDriver.js";
import type { PageAlert, PageElement, PageState, PageType } from "./types.js";

/** Classify page type from URL, title, and element signals */
function classifyPageType(
  url: string,
  title: string,
  elements: PageElement[],
): PageType {
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();
  const elementTexts = elements.map((e) => e.text.toLowerCase()).join(" ");

  // Check common patterns
  if (
    urlLower.includes("login") ||
    urlLower.includes("signin") ||
    urlLower.includes("sign-in") ||
    titleLower.includes("log in") ||
    titleLower.includes("sign in") ||
    (elementTexts.includes("password") && elementTexts.includes("email"))
  ) {
    return "login";
  }

  if (
    urlLower.includes("captcha") ||
    elementTexts.includes("prove you are human") ||
    elementTexts.includes("i am not a robot")
  ) {
    return "captcha";
  }

  if (
    urlLower.includes("checkout") ||
    urlLower.includes("payment") ||
    urlLower.includes("cart") ||
    titleLower.includes("checkout")
  ) {
    return "checkout";
  }

  if (
    urlLower.includes("settings") ||
    urlLower.includes("preferences") ||
    titleLower.includes("settings")
  ) {
    return "settings";
  }

  if (urlLower.includes("dashboard") || titleLower.includes("dashboard")) {
    return "dashboard";
  }

  if (urlLower.includes("search") || titleLower.includes("search results")) {
    return "search";
  }

  if (urlLower.includes("profile") || urlLower.includes("account")) {
    return "profile";
  }

  // Heuristic: if page has many form inputs, call it a form
  const inputCount = elements.filter((e) => e.role === "input" || e.role === "select" || e.role === "textarea").length;
  if (inputCount >= 3) return "form";

  // Feed heuristic: many links/articles
  const linkCount = elements.filter((e) => e.role === "link").length;
  if (linkCount >= 10) return "feed";

  // Article/content
  if (titleLower.length > 20 && linkCount < 5) return "article";

  // Error pages
  if (
    titleLower.includes("error") ||
    titleLower.includes("not found") ||
    titleLower.includes("403") ||
    titleLower.includes("404") ||
    titleLower.includes("500")
  ) {
    return "error";
  }

  return "unknown";
}

/** Build SHA-256 hash for change detection */
function buildHash(url: string, title: string, elements: PageElement[]): string {
  const content = url + "|" + title + "|" + elements.map((e) => e.text + e.selector).join("|");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Map raw DOM element roles to typed PageElement roles */
function normalizeRole(raw: string): PageElement["role"] {
  const map: Record<string, PageElement["role"]> = {
    button: "button",
    a: "link",
    link: "link",
    input: "input",
    text: "input",
    email: "input",
    password: "input",
    search: "input",
    checkbox: "checkbox",
    radio: "radio",
    select: "select",
    combobox: "select",
    menuitem: "menu",
    menu: "menu",
    tab: "tab",
  };
  return map[raw.toLowerCase()] ?? raw;
}

export class PageUnderstandingService {
  /**
   * Analyze the current page state using DOM extraction.
   * The driver should already have navigated to the target URL.
   */
  async analyze(driver: PlaywrightDriver): Promise<PageState> {
    const [url, title, rawElements, rawAlerts] = await Promise.all([
      driver.currentUrl(),
      driver.title(),
      driver.extractDOM(),
      driver.detectAlerts(),
    ]);

    // Map raw elements to typed PageElements
    const elements: PageElement[] = rawElements
      .filter((el) => el.visible)
      .map((el) => ({
        role: normalizeRole(el.role),
        text: el.text,
        selector: el.selector,
        bbox: el.bbox,
        visible: el.visible,
        enabled: el.enabled,
        // Confidence: elements with a selector + text score higher
        confidence: el.selector && el.text ? 0.9 : el.selector ? 0.7 : 0.5,
      }));

    const alerts: PageAlert[] = rawAlerts.map((a) => ({
      type: a.type as PageAlert["type"],
      text: a.text,
    }));

    const page_type = classifyPageType(url, title, elements);
    const hash = buildHash(url, title, elements);

    return {
      url,
      title,
      page_type,
      timestamp: new Date().toISOString(),
      elements,
      alerts,
      hash,
    };
  }
}

export type { PageState, PageElement, PageAlert, PageType };
