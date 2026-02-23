/**
 * PageState: structured "what's on screen" output from PageUnderstandingService.
 * This is the core Lens-style representation of the current browser state.
 */

export type PageType =
  | "login"
  | "feed"
  | "checkout"
  | "form"
  | "article"
  | "error"
  | "captcha"
  | "settings"
  | "dashboard"
  | "search"
  | "profile"
  | "unknown";

export type AlertType = "cookie_banner" | "captcha" | "2fa" | "modal" | "notification";

export type PageElement = {
  /** Semantic role */
  role: "button" | "link" | "input" | "checkbox" | "radio" | "select" | "menu" | "tab" | string;
  /** Visible text / label */
  text: string;
  /** CSS selector (best-effort) */
  selector: string;
  /** Bounding box in viewport pixels */
  bbox: { x: number; y: number; w: number; h: number };
  visible: boolean;
  enabled: boolean;
  /** Extraction confidence 0–1 */
  confidence: number;
};

export type PageAlert = {
  type: AlertType;
  text: string;
};

export type PageState = {
  url: string;
  title: string;
  page_type: PageType;
  timestamp: string;
  elements: PageElement[];
  alerts: PageAlert[];
  /** SHA-256 of url+title+element texts — use to detect changes */
  hash: string;
};
