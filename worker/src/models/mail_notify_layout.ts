/**
 * Pure renderings for the assignment notification (no I/O, unit-tested in mail_notify_layout.test.ts):
 *  - `mail.message_user_assigned` (odoo/addons/mail/data/mail_templates_chatter.xml:5-10) as it is stored after the
 *    mail.message Html field's sanitize (fields_textual.py:731 html_sanitize: several roots wrapped in one <span>,
 *    void tags as `<br>`, the style normalized, the surrounding whitespace dropped);
 *  - `mail.mail_notification_layout` (data/mail_templates_email_layouts.xml:4-92 with `mail.notification_preview`
 *    :169-175) for the branch of internal-user groups: header with the access button and subtitles, no footer
 *    (`email_notification_allow_footer` defaults to False, mail_thread.py:3958), the author's signature;
 *  - `mail.message.preview` (mail_message.py:318 `textwrap.shorten(html_to_inner_content(body), 190)`).
 * The QWeb output's whitespace is the template's (whitespace-only text around t-set/t-call/comments as QWeb keeps it).
 */
import { textwrapShorten } from "./util";

/** markupsafe escape as QWeb t-out writes text: & < > " ' */
export function qwebEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

/** lxml serialization of text after html_sanitize: & < > only. */
function textEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The stored body of `mail.message_user_assigned` for `object` (sanitized, see module comment). */
export function userAssignedBody(userName: string, modelDescription: string, displayName: string): string {
  return `<span><span>Dear ${textEscape(userName)},</span>\n    <br><br>\n    <span style="margin-top:8px">You have been assigned to the ${textEscape(modelDescription || "document")} ${textEscape(displayName)}.</span>\n    <br></span>`;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#34": '"', nbsp: " " };

/**
 * `tools.mail.html_to_inner_content` (odoo/odoo/tools/mail.py:590-603) then `textwrap.shorten(text, 190)`
 * (mail_message.py:318): opening div/p/br/tr tags and newlines become spaces, other tags vanish, runs of spaces and
 * tabs collapse, entities are unescaped; shorten then collapses all whitespace and truncates.
 */
export function messagePreview(body: string): string | null {
  let s = body.replace(/<(div|p|br|tr)[^>]*>|\n/g, " ");
  s = s.replace(/<[^\n]*?>/g, "");
  s = s.replace(/ {2,}|\t/g, " ").replace(/\u00a0/g, " ");
  s = s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    const v = ENTITIES[e];
    return v ?? m;
  }).trim();
  const joined = s.split(/\s+/u).filter((w) => w !== "").join(" ");
  return joined.length <= 190 ? joined : textwrapShorten(joined, 190, " [...]");
}

export interface LayoutValues {
  readonly lang: string;
  readonly subtypeInternal: boolean;
  readonly preview: string;
  readonly buttonUrl: string;
  readonly buttonTitle: string;
  readonly subtitles: readonly string[];
  readonly body: string;
  /** `<div>-- <br/>%s</div>` % author_user.signature, or null without signature. */
  readonly signature: string | null;
  /** `company.email_primary_color or '#FFFFFF'`, `company.email_secondary_color or '#875A7B'` (layout :35-36). */
  readonly primaryColor: string;
  readonly secondaryColor: string;
}

/** `mail.mail_notification_layout` for show_header and has_button_access, no footer (see module comment). */
export function notificationLayout(v: LayoutValues): string {
  const url = qwebEscape(v.buttonUrl);
  const title = qwebEscape(v.buttonTitle);
  const subtitles = v.subtitles.map((s, i) => {
    // subtitles_highlight_index = 0: bold for the first, '' for the others
    const style = i === 0 ? "font-weight:bold;" : "";
    return `\n                                        <span style="${style}">${qwebEscape(s)}</span>` +
      (i < v.subtitles.length - 1 ? "\n                                        <br/>" : "");
  }).join("");
  const subtitleCell = v.subtitles.length
    ? `\n                                <td style="font-size: 12px;">${subtitles}\n                                </td>\n`
    : null;
  if (subtitleCell === null) throw new Error("notificationLayout without subtitles (record name branch) is not ported");
  const preview = `${v.subtypeInternal ? "Internal communication: " : ""}${qwebEscape(v.preview)}`;
  return `
<html lang="${qwebEscape(v.lang)}">
<head>
    <meta http-equiv="Content-Type" content="text/html charset=UTF-8"/>
</head>
<body style="font-family:Verdana, Arial,sans-serif; color: #454748;">

<div style="display: none; max-height: 0px; overflow: hidden; color:#fff; font-size:0px; line-height:0px">
    ${preview}${"\n    \n    "}${"\u034f \u200b ".repeat(140)}
</div>
<div style="max-width: 900px; width: 100%;">
<div itemscope="itemscope" itemtype="http://schema.org/EmailMessage">
    <div itemprop="potentialAction" itemscope="itemscope" itemtype="http://schema.org/ViewAction">
        <link itemprop="target" href="${url}"/>
        <link itemprop="url" href="${url}"/>
        <meta itemprop="name" content="${title}"/>
    </div>
</div>
<div summary="o_mail_notification" style="padding: 0px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; margin-top: 5px;">
        <tbody>
            <tr>
                <td valign="center" style="white-space:nowrap;">
                    <table cellspacing="0" cellpadding="0" border="0">
                        <tbody>
                            <tr>
                                <td style="border-radius: 3px; text-align: center; background: ${qwebEscape(v.secondaryColor)};">
                                    <a href="${url}" style="font-size: 12px; color: ${qwebEscape(v.primaryColor)}; display: block; padding: 8px 12px 11px; text-decoration: none !important; font-weight: bold;">
                                        ${title}
                                    </a>
                                </td>
                                <td>&nbsp;&nbsp;</td>${subtitleCell}
                            </tr>
                        </tbody>
                    </table>
                </td>
            </tr>
            <tr>
                <td valign="center">
                    <hr width="100%" style="background-color:rgb(204,204,204);border:medium none;clear:both;display:block;font-size:0px;min-height:1px;line-height:0;margin: 10px 0px;"/>
                </td>
            </tr>
        </tbody>
    </table>
</div>

<div style="font-size: 13px;">${v.body}</div>
${v.signature !== null ? `\n    <div class="o_signature" style="font-size: 13px;">${v.signature}</div>\n` : "\n"}

</div>
</body></html>`;
}
