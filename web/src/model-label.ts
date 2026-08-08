/**
 * What the header chip shows when it cannot show the whole model id (D-71).
 *
 * The chip used to be a plain `text-overflow: ellipsis`, which cuts the **end**
 * — so `openai/gpt-4o-mini` rendered as `openai/gpt-4o-mi…`: the vendor kept,
 * the model hidden. That is backwards on both counts. The vendor is the part you
 * can infer (nobody else ships `gpt-4o-mini`), and the tail is where the part you
 * cannot infer lives: `anthropic/claude-opus-5:online` differs from
 * `anthropic/claude-opus-5` only in its last seven characters, and that suffix
 * decides whether the model gets web search.
 *
 * So the rule is: **elide from the front, never the back.** Drop leading path
 * segments first (marking the drop with `…/`, so the chip still reads as an id);
 * only if that is not enough, elide from the middle of what is left, giving the
 * tail the larger share. The full id always rides along in the `title`.
 *
 * The budget is in **characters, not pixels**, and it is decided here rather than
 * by the layout engine. The chip is monospace, so a character budget is a width;
 * and the failure this module exists to prevent is precisely "CSS decided what to
 * cut", since CSS's only answer is to cut the tail.
 */

/** The chip's budget, in characters. `anthropic/claude-opus-5:online` is 30, so
 *  the longest id Joshua actually runs elides its vendor and keeps everything
 *  that identifies the model — which is the whole point. `styles.css` states the
 *  same number in `ch`; the two must agree or CSS becomes the truncator again. */
export const MODEL_CHIP_CHARS = 28;

/** Elide from the middle, keeping more of the tail than the head. `0.6` is not
 *  load-bearing — it just means a forced middle cut still shows `:online` rather
 *  than half of it. */
function middleElide(s: string, budget: number): string {
  if (s.length <= budget) return s;
  if (budget <= 1) return "…";
  const keep = budget - 1; // one character goes to the ellipsis itself
  const tail = Math.ceil(keep * 0.6);
  return `${s.slice(0, keep - tail)}…${s.slice(s.length - tail)}`;
}

/**
 * The model id as the chip should render it, at most `max` characters long.
 *
 * Returns the id untouched when it fits — the common case, and the one where any
 * cleverness would be a regression.
 */
export function fitModelLabel(id: string, max: number = MODEL_CHIP_CHARS): string {
  const full = id.trim();
  if (!full) return "";
  if (full.length <= max) return full;
  if (max <= 1) return "…";

  // 1. Drop leading segments — the vendor, then any further namespace above the
  //    model itself (`openrouter/anthropic/…`). `…/` keeps the shape of an id
  //    rather than pretending the vendor was never there.
  const segments = full.split("/");
  const hadVendor = segments.length > 1;
  while (segments.length > 1) {
    segments.shift();
    const dropped = `…/${segments.join("/")}`;
    if (dropped.length <= max) return dropped;
  }

  // 2. The model name alone is still too long. Elide its middle, and keep saying
  //    that a vendor was dropped — otherwise `…/claud…5:online` and a model that
  //    genuinely starts with an ellipsis read the same.
  const prefix = hadVendor ? "…/" : "";
  return prefix + middleElide(segments[0]!, max - prefix.length);
}
