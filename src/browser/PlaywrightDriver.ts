/**
 * PlaywrightDriver: high-level browser actions for autonomous agents.
 *
 * Wraps playwright-core with agent-friendly methods:
 *   navigate, click, type, screenshot, extractDOM
 */

import type { BrowserContext, Page } from "playwright-core";

export type ClickTarget = { selector?: string; text?: string };
export type TypeTarget = { selector: string; text: string; submit?: boolean };
export type ScrollTarget = { direction: "up" | "down"; amount?: number };

export type DOMElement = {
  role: string;
  text: string;
  selector: string;
  bbox: { x: number; y: number; w: number; h: number };
  visible: boolean;
  enabled: boolean;
};

export class PlaywrightDriver {
  private context: BrowserContext;
  private _page?: Page;

  constructor(context: BrowserContext) {
    this.context = context;
  }

  private async page(): Promise<Page> {
    if (!this._page || this._page.isClosed()) {
      this._page = await this.context.newPage();
    }
    return this._page;
  }

  async navigate(url: string): Promise<void> {
    const pg = await this.page();
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async currentUrl(): Promise<string> {
    return (await this.page()).url();
  }

  async title(): Promise<string> {
    return (await this.page()).title();
  }

  /** Click the first matching element */
  async click(target: ClickTarget): Promise<void> {
    const pg = await this.page();
    if (target.selector) {
      await pg.click(target.selector, { timeout: 10_000 });
    } else if (target.text) {
      await pg.getByText(target.text).first().click({ timeout: 10_000 });
    }
  }

  /** Type into a selector, optionally submitting with Enter */
  async type(target: TypeTarget): Promise<void> {
    const pg = await this.page();
    await pg.fill(target.selector, target.text);
    if (target.submit) {
      await pg.keyboard.press("Enter");
    }
  }

  async scroll(target: ScrollTarget): Promise<void> {
    const pg = await this.page();
    const delta = (target.amount ?? 500) * (target.direction === "down" ? 1 : -1);
    await pg.evaluate((dy: number) => window.scrollBy(0, dy), delta);
  }

  /** Take a full-page screenshot as PNG bytes */
  async screenshot(fullPage = false): Promise<Uint8Array> {
    const pg = await this.page();
    return pg.screenshot({ type: "png", fullPage });
  }

  /**
   * Extract interactive DOM elements from the current page.
   * Returns structured element list used by PageUnderstandingService.
   */
  async extractDOM(): Promise<DOMElement[]> {
    const pg = await this.page();

    // Run in page context to collect all interactive elements
    const raw = await pg.evaluate(() => {
      const selectors = [
        "button",
        "a[href]",
        "[role=button]",
        "input",
        "select",
        "textarea",
        "[role=menuitem]",
        "[role=tab]",
        "[role=checkbox]",
        "[role=radio]",
        "[role=link]",
        "[role=combobox]",
        "[type=submit]",
      ].join(", ");

      const elements = Array.from(document.querySelectorAll(selectors));
      return elements.slice(0, 100).map((el) => {
        const rect = el.getBoundingClientRect();
        const input = el as HTMLInputElement;

        // Determine role
        let role = el.tagName.toLowerCase();
        if (el.getAttribute("role")) role = el.getAttribute("role") ?? role;
        else if (role === "a") role = "link";
        else if (role === "input") role = input.type ?? "input";

        // Determine text label
        const text =
          (el as HTMLElement).innerText?.trim() ||
          el.getAttribute("aria-label")?.trim() ||
          el.getAttribute("placeholder")?.trim() ||
          el.getAttribute("title")?.trim() ||
          input.value?.trim() ||
          "";

        // Build a short CSS selector
        const id = el.id ? `#${el.id}` : "";
        const cls = el.className
          ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".")
          : "";
        const selector = id || (el.tagName.toLowerCase() + cls) || el.tagName.toLowerCase();

        const style = window.getComputedStyle(el);
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          parseFloat(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0;

        return {
          role,
          text: text.slice(0, 120),
          selector,
          bbox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          visible,
          enabled: !(el as HTMLButtonElement).disabled,
        };
      });
    });

    return raw as DOMElement[];
  }

  /** Detect blocking overlays: modals, cookie banners, captcha iframes */
  async detectAlerts(): Promise<Array<{ type: string; text: string }>> {
    const pg = await this.page();
    return pg.evaluate(() => {
      const alerts: Array<{ type: string; text: string }> = [];

      // Cookie consent banners
      const cookieKeywords = ["cookie", "accept", "gdpr", "consent"];
      document.querySelectorAll("[id],[class]").forEach((el) => {
        const label = ((el.id || el.className || "").toString()).toLowerCase();
        if (cookieKeywords.some((kw) => label.includes(kw))) {
          const txt = (el as HTMLElement).innerText?.slice(0, 200).trim();
          if (txt) alerts.push({ type: "cookie_banner", text: txt });
        }
      });

      // Dialogs / modals
      document.querySelectorAll("[role=dialog],[role=alertdialog]").forEach((el) => {
        const txt = (el as HTMLElement).innerText?.slice(0, 200).trim();
        if (txt) alerts.push({ type: "modal", text: txt });
      });

      // Captcha iframes
      document.querySelectorAll("iframe").forEach((fr) => {
        const src = fr.src ?? "";
        if (src.includes("recaptcha") || src.includes("hcaptcha") || src.includes("captcha")) {
          alerts.push({ type: "captcha", text: src });
        }
      });

      return alerts.slice(0, 10);
    }) as Promise<Array<{ type: string; text: string }>>;
  }

  async close(): Promise<void> {
    if (this._page && !this._page.isClosed()) {
      await this._page.close();
    }
  }
}
