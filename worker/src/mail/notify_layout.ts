/**
 * `mail.mail_notification_layout` (odoo/addons/mail/data/mail_templates_email_layouts.xml:4-92, with
 * `mail.notification_preview` :169-175) as QWeb renders it for notification emails without footer
 * (`email_notification_allow_footer` defaults to False, mail_thread.py:3958): the header (access button and
 * subtitles) for groups with `has_button_access` (the internal users), none for customers. Generalized from stream
 * CRM's src/models/mail_notify_layout.ts (internal-user branch), whose `qwebEscape`/`messagePreview` it reuses.
 * The whitespace is QWeb's: a falsy `t-if` drops the whitespace text before it (hence no indent before a preview
 * without the "Internal communication" prefix). Checked against the S3 and C3 reference bodies (write.test.ts).
 */
import { NotPorted } from '../errors';
import { qwebEscape } from '../models/mail_notify_layout';

export interface EmailLayout {
  readonly lang: string;
  readonly subtypeInternal: boolean;
  /** `message.preview` (mail_message.py:318). */
  readonly preview: string;
  /** null for groups without `has_button_access`. */
  readonly button: { readonly url: string; readonly title: string } | null;
  /** `email_notification_force_header`: the header also without the button. */
  readonly forceHeader?: boolean;
  readonly subtitles: readonly string[];
  /** `message.body` (Markup, written as is). */
  readonly body: string;
  /** `<div>-- <br/>%s</div>` % author_user.signature, or null (no author user / no signature asked). */
  readonly signature: string | null;
  readonly primaryColor: string;
  readonly secondaryColor: string;
  /** `show_footer` (email_notification_force_footer): the company block and "Powered by Odoo" (:72-90). */
  readonly footer?: { readonly name: string; readonly phone: string; readonly email: string; readonly website: string } | null;
  /** `show_unfollow` (mail_thread.py:3855-3861): an internal recipient of this or an earlier group follows the record. */
  readonly showUnfollow?: boolean;
  /**
   * `account_peppol.mail_notification_layout_with_responsible_signature_and_peppol` (account_peppol
   * data/mail_templates_email_layouts.xml:4-27 over mail's mail_notification_layout_with_responsible_signature, mail
   * mail_templates_email_layouts.xml:177-186): the record responsible's signature and the Peppol status replace the
   * author's signature; only without both is ported, as measured on Odoo's mails of invoices sent from the send wizard
   * (2026-11-07, with and without the footer).
   */
  readonly responsiblePeppol?: boolean;
  /** The layout's terms in the rendering language (src/mail/view_terms.ts); en_US when absent. */
  readonly tr?: (term: string) => string;
}

/** mail_templates_email_layouts.xml:86-88, :160-162 (`show_unfollow`); mail.mail personalizes the link when sending. */
const UNFOLLOW = '\n    <span id="mail_unfollow">\n        | <a href="/mail/unfollow" style="text-decoration:none; color:#555555;">Unfollow</a>\n    </span>';
const unfollow = (tr: (t: string) => string): string => UNFOLLOW.replace('>Unfollow<', `>${tr('Unfollow')}<`);
const identity = (t: string): string => t;

function footer(v: EmailLayout, f: { name: string; phone: string; email: string; website: string }): string {
  // the variant with phone, email and website all set (others refuse at the caller)
  return `
<div style="margin-top:16px;">
    <hr width="100%" style="background-color:rgb(204,204,204);border:medium none;clear:both;display:block;font-size:0px;min-height:1px;line-height:0; margin: 16px 0px 4px 0px;"/>
    <b style="font-size:11px;">${qwebEscape(f.name)}</b><br/>
    <p style="color: #999999; margin-top:2px; font-size:11px;">
        ${qwebEscape(f.phone)}
         |
        <a style="text-decoration:none; color: #999999;" href="mailto:${qwebEscape(f.email)}">${qwebEscape(f.email)}</a>
         |
        <a style="text-decoration:none; color: #999999;" href="${qwebEscape(f.website)}">${qwebEscape(f.website)}</a>
    </p>
</div>
<div style="color: #555555; font-size:11px;">
    ${(v.tr ?? identity)('Powered by')} <a target="_blank" href="https://www.odoo.com?utm_source=db&amp;utm_medium=email" style="color: ${qwebEscape(v.secondaryColor)};">Odoo</a>${v.showUnfollow ? unfollow(v.tr ?? identity) : ''}
</div>`;
}

/**
 * The header of mail_notification_layout (mail_templates_email_layouts.xml:19-65); `button` null is the forced header
 * of a group without access button (`email_notification_force_header`, :11-12): no schema.org block nor button cells
 * (checked against Odoo's mail for a user outside group_project_user on a task).
 */
function header(v: EmailLayout, button: { url: string; title: string } | null): string {
  if (!v.subtitles.length) throw new Error('notification layout without subtitles (record name cell) is not ported');
  const subtitles = v.subtitles.map((s, i) =>
    `\n                                        <span style="${i === 0 ? 'font-weight:bold;' : ''}">${qwebEscape(s)}</span>`
    + (i < v.subtitles.length - 1 ? '\n                                        <br/>' : '')).join('');
  if (button === null) return `
<div summary="o_mail_notification" style="padding: 0px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; margin-top: 5px;">
        <tbody>
            <tr>
                <td valign="center" style="white-space:nowrap;">
                    <table cellspacing="0" cellpadding="0" border="0">
                        <tbody>
                            <tr>
                                <td style="font-size: 12px;">${subtitles}
                                </td>

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
</div>`;
  const url = qwebEscape(button.url), title = qwebEscape(button.title);
  return `
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
                                <td>&nbsp;&nbsp;</td>
                                <td style="font-size: 12px;">${subtitles}
                                </td>

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
</div>`;
}

/**
 * The signature part of the responsible/Peppol layout: the falsy responsible signature `div` and the falsy Peppol `div`
 * leave QWeb's whitespace of the inherited views (the second line's indent is the xpath's, the third the Peppol view's).
 */
function responsiblePeppolSignature(v: EmailLayout): string {
  if (v.signature !== null) throw new NotPorted('responsible signature layout with the responsible\'s signature');
  return '\n                \n            ';
}

export function emailLayout(v: EmailLayout): string {
  const preview = `${v.subtypeInternal ? `\n    ${(v.tr ?? identity)('Internal communication:')} ` : ''}${qwebEscape(v.preview)}`;
  return `
<html lang="${qwebEscape(v.lang)}">
<head>
    <meta http-equiv="Content-Type" content="text/html charset=UTF-8"/>
</head>
<body style="font-family:Verdana, Arial,sans-serif; color: #454748;">

<div style="display: none; max-height: 0px; overflow: hidden; color:#fff; font-size:0px; line-height:0px">${preview}\n    \n    ${'͏ ​ '.repeat(140)}
</div>
<div style="max-width: 900px; width: 100%;">${v.button ? header(v, v.button) : v.forceHeader ? header(v, null) : ''}

<div style="font-size: 13px;">${v.body}</div>
${v.responsiblePeppol ? responsiblePeppolSignature(v) : `${v.signature !== null ? `\n    <div class="o_signature" style="font-size: 13px;">${v.signature}</div>\n` : '\n'}
`}${v.footer ? footer(v, v.footer) : ''}
</div>
</body></html>`;
}

export interface LightLayout {
  readonly lang: string;
  /** `message.preview` (mail_message.py:318). */
  readonly preview: string;
  readonly modelDescription: string;
  readonly recordName: string;
  /** `button_access['url']` for groups with `has_button_access`. */
  readonly buttonUrl: string | null;
  readonly body: string;
  /** phone, email and website all set (others refuse at the caller). */
  readonly company: { readonly name: string; readonly phone: string; readonly email: string; readonly website: string };
  readonly secondaryColor: string;
  /** `show_unfollow`, as EmailLayout. */
  readonly showUnfollow?: boolean;
  /** The layout's terms in the rendering language (src/mail/view_terms.ts); en_US when absent. */
  readonly tr?: (term: string) => string;
}

/**
 * `mail.mail_notification_light` (data/mail_templates_email_layouts.xml:94-167) for a company with the default logo:
 * the template stage's email. Checked against the G235 reference; the branch without access button follows QWeb's
 * rule above (a falsy `t-if` drops the whitespace before it) and has no reference.
 */
export function lightLayout(v: LightLayout): string {
  const tr = v.tr ?? ((t: string): string => t);
  const name = qwebEscape(v.recordName.replace(/\//g, '-'));
  const title = v.buttonUrl !== null
    ? `
                        <a href="${qwebEscape(v.buttonUrl)}">
                            <span style="font-size: 20px; font-weight: bold;">
                                ${name}
                            </span>
                        </a>`
    : `
                        <span style="font-size: 20px; font-weight: bold;">
                            ${name}
                        </span>`;
  const c = v.company;
  return `
<html lang="${qwebEscape(v.lang)}">
<head>
    <meta http-equiv="Content-Type" content="text/html charset=UTF-8"/>
</head>
<body>
<div style="display: none; max-height: 0px; overflow: hidden; color:#fff; font-size:0px; line-height:0px">${qwebEscape(v.preview)}\n    \n    ${'͏ ​ '.repeat(140)}
</div>
<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="padding-top: 16px; background-color: #F1F1F1; font-family:Verdana, Arial,sans-serif; color: #454748; width: 100%; border-collapse:separate;"><tr><td align="center">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="590" style="padding: 24px; background-color: white; color: #454748; border-collapse:separate;">
<tbody>
    
    <tr>
        <td align="center" style="min-width: 590px;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: white; padding: 0; border-collapse:separate;">
                <tr><td valign="middle">
                    <span style="font-size: 10px;">${tr("Your")} ${qwebEscape(v.modelDescription)}</span>
                    <br/>${title}
                </td></tr>
                <tr><td colspan="2" style="text-align:center;">
                  <hr width="100%" style="background-color:rgb(204,204,204);border:medium none;clear:both;display:block;font-size:0px;min-height:1px;line-height:0; margin:4px 0px 32px 0px;"/>
                </td></tr>
            </table>
        </td>
    </tr>
    
    <tr>
        <td style="min-width: 590px;">
            ${v.body}
        </td>
    </tr>
    
    <tr>
        <td align="center" style="min-width: 590px; padding: 0 8px 0 8px; font-size:11px;">
            <hr width="100%" style="background-color:rgb(204,204,204);border:medium none;clear:both;display:block;font-size:0px;min-height:1px;line-height:0; margin: 16px 0px 4px 0px;"/>
            <b style="font-size:11px;">${qwebEscape(c.name)}</b><br/>
            <p style="color: #999999; margin-top:2px; font-size:11px;">
                ${qwebEscape(c.phone)}
                 |
                <a style="text-decoration:none; color: #999999;" href="mailto:${qwebEscape(c.email)}">${qwebEscape(c.email)}</a>
                 |
                <a style="text-decoration:none; color: #999999;" href="${qwebEscape(c.website)}">${qwebEscape(c.website)}</a>
            </p>
        </td>
    </tr>
</tbody>
</table>
</td></tr>

<tr><td align="center" style="min-width: 590px;">
    ${tr("Powered by")} <a target="_blank" href="https://www.odoo.com?utm_source=db&amp;utm_medium=email" style="color: ${qwebEscape(v.secondaryColor)};">Odoo</a>${v.showUnfollow ? unfollow(tr) : ''}
</td></tr>
</table>
</body>
</html>`;
}
