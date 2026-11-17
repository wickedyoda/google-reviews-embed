/**
 * <google-reviews> — renders Google reviews from a self-hosted proxy.
 *
 *   <script src="https://reviews.example.com/embed.js" defer></script>
 *   <google-reviews business="moms-originals" limit="3"></google-reviews>
 *
 * Attributes
 *   business   slug from businesses.json (the normal, quota-safe way)
 *   place-id   raw Google place ID — only works if the server sets ALLOW_ANY_PLACE=1
 *   endpoint   origin of the reviews proxy (default: the script's own origin)
 *   limit      number of reviews to show, 1-5 (default 5)
 *   min-rating only show reviews at or above this star rating (0-5)
 *   theme      "light" | "dark" | "auto" (default auto)
 *   lazy       "false" to fetch immediately instead of on-scroll
 *   heading    custom heading text; empty string hides it
 *   show-count "false" hides the review-count line
 *
 * Review text is inserted with textContent — never innerHTML — because review
 * bodies are third-party content. Google attribution is always rendered.
 */
(() => {
  const STYLE_ID = "google-reviews-styles";
  const DEFAULTS = { limit: 5, theme: "auto", minRating: 0 };

  function scriptOrigin() {
    const s = document.currentScript || [...document.scripts].reverse().find((x) => /embed\.js(\?|$)/.test(x.src));
    try { return s && s.src ? new URL(s.src).origin : ""; } catch { return ""; }
  }

  function ensureStyles(origin) {
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = `${origin}/widget.css`;
    document.head.appendChild(link);
  }

  function stars(rating) {
    const wrap = document.createElement("span");
    wrap.className = "gre-stars";
    const filled = Math.round(Number(rating) || 0);
    wrap.setAttribute("aria-label", `${filled} out of 5 stars`);
    for (let i = 1; i <= 5; i += 1) {
      const s = document.createElement("span");
      s.className = i <= filled ? "gre-star gre-star--on" : "gre-star";
      s.textContent = "★";
      s.setAttribute("aria-hidden", "true");
      wrap.appendChild(s);
    }
    return wrap;
  }

  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  }

  const template = document.createElement("template");
  template.innerHTML = `
    <section class="gre" part="root">
      <header class="gre__header">
        <div class="gre__summary">
          <span class="gre__score" data-score></span>
          <span class="gre__meta" data-meta></span>
        </div>
        <a class="gre__brand" data-brand target="_blank" rel="noopener nofollow">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M21.35 11.1H12v2.9h5.3c-.23 1.4-1.66 4.1-5.3 4.1a6.1 6.1 0 1 1 0-12.2c1.75 0 2.92.75 3.59 1.4l2.05-1.98C16.9 3.6 14.7 2.7 12 2.7a9.3 9.3 0 1 0 0 18.6c5.37 0 8.93-3.77 8.93-9.08 0-.61-.06-1.07-.13-1.52Z"/></svg>
          <span>Google reviews</span>
        </a>
      </header>
      <h3 class="gre__heading" data-heading hidden></h3>
      <div class="gre__list" data-list role="list"></div>
      <p class="gre__status" data-status hidden></p>
    </section>`;

  class GoogleReviews extends HTMLElement {
    #loaded = false;
    #observer = null;
    #origin = "";

    static get observedAttributes() {
      return ["business", "place-id", "limit", "endpoint", "theme", "min-rating", "heading", "lazy", "show-count"];
    }

    connectedCallback() {
      if (!this.shadowRoot) {
        this.attachShadow({ mode: "open" });
        this.shadowRoot.appendChild(template.content.cloneNode(true));
      }
      this.#origin = (this.getAttribute("endpoint") || scriptOrigin()).replace(/\/$/, "");
      ensureStyles(this.#origin);
      this.#applyTheme();

      if (this.getAttribute("lazy") !== "false" && "IntersectionObserver" in window) {
        this.#observer = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            this.#observer.disconnect();
            this.load();
          }
        }, { rootMargin: "200px" });
        this.#observer.observe(this);
      } else {
        this.load();
      }
    }

    disconnectedCallback() { this.#observer?.disconnect(); }

    attributeChangedCallback() {
      if (this.#loaded && this.isConnected) this.load();
    }

    get #els() {
      const r = this.shadowRoot;
      return {
        score: r.querySelector("[data-score]"),
        meta: r.querySelector("[data-meta]"),
        list: r.querySelector("[data-list]"),
        status: r.querySelector("[data-status]"),
        brand: r.querySelector("[data-brand]"),
        heading: r.querySelector("[data-heading]"),
      };
    }

    #applyTheme() {
      const theme = this.getAttribute("theme") || DEFAULTS.theme;
      const dark = theme === "dark" || (theme === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
      this.setAttribute("data-theme", dark ? "dark" : "light");
    }

    async load() {
      const { score, meta, list, status, brand, heading } = this.#els;
      const business = this.getAttribute("business") || "";
      const placeId = this.getAttribute("place-id") || "";
      const limit = Math.min(5, Math.max(1, Number(this.getAttribute("limit")) || DEFAULTS.limit));
      const minRating = Number(this.getAttribute("min-rating")) || DEFAULTS.minRating;
      const customHeading = this.getAttribute("heading"); // null → use business label
      const showCount = this.getAttribute("show-count") !== "false";

      list.replaceChildren();
      status.hidden = false;
      status.textContent = "Loading reviews…";

      const url = new URL(`${this.#origin}/api/reviews`);
      if (business) url.searchParams.set("business", business);
      else if (placeId) url.searchParams.set("place", placeId);
      url.searchParams.set("limit", String(limit));

      try {
        const res = await fetch(url, { credentials: "omit" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail = data?.error === "unknown_business" ? "unknown business" : `HTTP ${res.status}`;
          throw new Error(detail);
        }

        const label = data?.business?.label || "";
        const headingText = customHeading === null ? label : customHeading;
        if (headingText) {
          heading.textContent = headingText;
          heading.hidden = false;
        } else {
          heading.hidden = true;
        }

        const reviews = (data.reviews || []).filter((r) => (r.rating ?? 5) >= minRating);

        score.textContent = data.rating != null ? Number(data.rating).toFixed(1) : "";
        meta.textContent = showCount && data.userRatingCount != null
          ? `${data.userRatingCount.toLocaleString()} Google reviews`
          : "";
        if (data.googleMapsUri) brand.href = data.googleMapsUri;
        brand.title = label ? `${label} on Google` : "Google reviews";

        if (!reviews.length) {
          status.hidden = false;
          status.textContent = "No reviews to show yet.";
        } else {
          for (const r of reviews) {
            const card = document.createElement("article");
            card.className = "gre-card";
            card.setAttribute("role", "listitem");

            const top = document.createElement("div");
            top.className = "gre-card__top";

            const avatar = document.createElement("span");
            avatar.className = "gre-card__avatar";
            avatar.textContent = initials(r.author);
            if (r.authorPhoto) {
              avatar.style.backgroundImage = `url("${String(r.authorPhoto).replace(/"/g, "%22")}")`;
              avatar.classList.add("gre-card__avatar--photo");
              avatar.textContent = "";
            }

            const who = document.createElement("div");
            who.className = "gre-card__who";
            const name = document.createElement("span");
            name.className = "gre-card__author";
            name.textContent = r.author || "Google user";
            const when = document.createElement("span");
            when.className = "gre-card__when";
            when.textContent = r.relativeTime || "";
            who.append(name, when);

            top.append(avatar, who, stars(r.rating));
            card.appendChild(top);

            const text = document.createElement("p");
            text.className = "gre-card__text";
            text.textContent = r.text;
            card.appendChild(text);

            if (r.googleMapsUri) {
              const link = document.createElement("a");
              link.className = "gre-card__link";
              link.href = r.googleMapsUri;
              link.target = "_blank";
              link.rel = "noopener nofollow";
              link.textContent = "View on Google";
              card.appendChild(link);
            }

            list.appendChild(card);
          }
          status.hidden = true;
        }

        this.#loaded = true;
        this.dispatchEvent(new CustomEvent("google-reviews:loaded", { detail: data, bubbles: true }));
      } catch (err) {
        status.hidden = false;
        status.textContent = "Reviews are unavailable right now.";
        this.dispatchEvent(new CustomEvent("google-reviews:error", { detail: err, bubbles: true }));
      }
    }
  }

  if (!customElements.get("google-reviews")) customElements.define("google-reviews", GoogleReviews);
})();
