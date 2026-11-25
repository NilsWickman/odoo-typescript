/**
 * The "Mark Lost" wizard crm.lead.lost (odoo/addons/crm/wizard/crm_lead_lost.py): a transient model without Python
 * defaults (lead_ids comes from the action's `default_lead_ids` context) and `action_lost_reason_apply` (:16-27).
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { registerDefaults } from "../orm/recompute";
import { setTrackingLogMessage, withLeadTracking } from "./crm_lead_mail";
import { escapeText } from "../mail/message";
import { actionSetLost } from "./crm_lead_pls";
import { translate } from "./util";

// crm_lead_lost.py:12-16: no `default=` on the fields
registerDefaults("crm.lead.lost", {});

/** tools/mail.py:525-538 `is_html_empty`: only formatting tags (p, div, section, span, br, b, i, font) and blanks. */
export function isHtmlEmpty(html: string | null | false): boolean {
  if (!html) return true;
  const iconRe = /<\s*(i|span)\b(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"])?)*\s*\bclass\s*=\s*["'][^"']*\b(fa|fab|fad|far|oi)\b/;
  const tagRe = /<\s*\/?(?:p|div|section|span|br|b|i|font)\b(?:(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"]))*)(?:\s*>|\s*\/\s*>)/g;
  const text = html.replace(tagRe, "");
  if (/&(?!(?:amp|lt|gt|quot|#39|nbsp);)[a-zA-Z#0-9]+;/.test(text)) throw new NotPorted("is_html_empty: html.unescape of other entities");
  const unescaped = text.replace(/&nbsp;/g, "\u00a0").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return unescaped.trim() === "" && !iconRe.test(html);
}

registerMethod("crm.lead.lost", "action_lost_reason_apply", async (env, ids) => withLeadTracking(env, async () => {
  if (ids === null || ids.length !== 1) throw new NotPorted("action_lost_reason_apply on several records (ensure_one)");
  const [wizard] = await env.model("crm.lead.lost").read(ids, ["lead_ids", "lost_reason_id", "lost_feedback"], "");
  if (wizard === undefined) throw new NotPorted("action_lost_reason_apply on a missing wizard");
  const leadIds = Array.isArray(wizard["lead_ids"]) ? wizard["lead_ids"].map(Number) : [];
  const feedback = typeof wizard["lost_feedback"] === "string" ? wizard["lost_feedback"] : null;
  if (!isHtmlEmpty(feedback)) {
    // :19-24 Markup('<div style="margin-bottom: 4px;"><p>%s:</p>%s<br /></div>'), stored through mail.message's
    // html_sanitize, which rewrites the style as "margin-bottom:4px" and serializes <br /> as <br>
    const body = `<div style="margin-bottom:4px"><p>${escapeText(translate(env, "Lost Comment"))}:</p>${feedback}<br></div>`;
    for (const id of leadIds) setTrackingLogMessage(env, id, body);
  }
  const reason = typeof wizard["lost_reason_id"] === "number" ? wizard["lost_reason_id"] : false;
  // :25-26 action_set_lost(lost_reason_id=...) returns the action_archive result (None -> False)
  return actionSetLost(env, leadIds, { lost_reason_id: reason });
}), { apiModel: false });
