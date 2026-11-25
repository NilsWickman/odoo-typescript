/**
 * OdooBot's answers in a chat with it (mail_bot/models/mail_bot.py `_apply_logic` :14-38, `_get_answer` :57-195),
 * run by mail_bot's `_message_post_after_hook` on discuss.channel (mail_bot/models/discuss_channel.py:13-15) before
 * discuss's. Returns the answers' bodies (html, before the message field's sanitize) after writing the user's
 * onboarding state as Odoo does (`self.env.user.<field> = ...`: one write per assignment, as sudo).
 *
 * Not reached through the port's channel post, which refuses them first: mentions (`odoobot in message.partner_ids`),
 * attachments and canned responses. The answer chosen with `random.choice` (:178-194) refuses.
 */
import { NotPorted } from '../errors';
import { write } from '../orm/write';
import type { Environment } from '../orm/types';
import { htmlEscape, translateLang } from '../models/util';

/** mail_bot.py:41-55 `_get_style_dict`. */
const STYLE: Readonly<Record<string, string>> = {
  new_line: '<br>', bold_start: '<b>', bold_end: '</b>',
  command_start: "<span class='o_odoobot_command'>", command_end: '</span>',
  document_link_start: "<a href='https://www.odoo.com/documentation' target='_blank'>", document_link_end: '</a>',
  slides_link_start: "<a href='https://www.odoo.com/slides' target='_blank'>", slides_link_end: '</a>',
  paperclip_icon: "<i class='oi' data-icon='attach_file' aria-hidden='true'/>",
  smile_icon: "<i class='oi' data-icon='sentiment_satisfied' aria-hidden='true'/>",
  plus_icon: "<i class='oi oi-filled' data-icon='add_circle' aria-hidden='true'/>",
};

/**
 * `self.env._(source, **style)` (tools/translate.py:980-1000): the translation, escaped because the arguments are
 * Markup, then `%`-formatted with them; without arguments the plain text, which message_post escapes (`escape(body)`).
 */
function styled(lang: string, source: string): string {
  const translation = translateLang(lang, source, 'mail_bot');
  return htmlEscape(translation).replace(/%\((\w+)\)s/g, (m, k: string) => {
    const v = STYLE[k];
    if (v === undefined) throw new NotPorted(`OdooBot answer argument ${k}`);
    return v;
  });
}
const plain = (lang: string, source: string): string => htmlEscape(translateLang(lang, source, 'mail_bot'));

/** mail_bot.py:196-326 `_body_contains_emoji`. */
const EMOJI_RANGES: readonly [number, number][] = [
  [0x231A, 0x231c], [0x23E9, 0x23f4], [0x23F8, 0x23fb], [0x25AA, 0x25ac], [0x25FB, 0x25ff], [0x2600, 0x2605], [0x2614, 0x2616],
  [0x2622, 0x2624], [0x262E, 0x2630], [0x2638, 0x263b], [0x2648, 0x2654], [0x265F, 0x2661], [0x2665, 0x2667], [0x267E, 0x2680],
  [0x2692, 0x2698], [0x269B, 0x269d], [0x26A0, 0x26a2], [0x26AA, 0x26ac], [0x26B0, 0x26b2], [0x26BD, 0x26bf], [0x26C4, 0x26c6],
  [0x26D3, 0x26d5], [0x26E9, 0x26eb], [0x26F0, 0x26f6], [0x26F7, 0x26fb], [0x2708, 0x270a], [0x270A, 0x270c], [0x270C, 0x270e],
  [0x2733, 0x2735], [0x2753, 0x2756], [0x2763, 0x2765], [0x2795, 0x2798], [0x2934, 0x2936], [0x2B05, 0x2b08], [0x2B1B, 0x2b1d],
  [0x1F170, 0x1f172], [0x1F191, 0x1f19b], [0x1F1E6, 0x1f200], [0x1F201, 0x1f203], [0x1F232, 0x1f23b], [0x1F250, 0x1f252],
  [0x1F300, 0x1f321], [0x1F324, 0x1f32d], [0x1F32D, 0x1f330], [0x1F330, 0x1f336], [0x1F337, 0x1f37d], [0x1F37E, 0x1f380],
  [0x1F380, 0x1f394], [0x1F396, 0x1f398], [0x1F399, 0x1f39c], [0x1F39E, 0x1f3a0], [0x1F3A0, 0x1f3c5], [0x1F3C6, 0x1f3cb],
  [0x1F3CB, 0x1f3cf], [0x1F3CF, 0x1f3d4], [0x1F3D4, 0x1f3e0], [0x1F3E0, 0x1f3f1], [0x1F3F3, 0x1f3f6], [0x1F3F8, 0x1f400],
  [0x1F400, 0x1f43f], [0x1F442, 0x1f4f8], [0x1F4F9, 0x1f4fd], [0x1F500, 0x1f53e], [0x1F549, 0x1f54b], [0x1F54B, 0x1f54f],
  [0x1F550, 0x1f568], [0x1F56F, 0x1f571], [0x1F573, 0x1f57a], [0x1F58A, 0x1f58e], [0x1F595, 0x1f597], [0x1F5B1, 0x1f5b3],
  [0x1F5C2, 0x1f5c5], [0x1F5D1, 0x1f5d4], [0x1F5DC, 0x1f5df], [0x1F5FB, 0x1f600], [0x1F601, 0x1f611], [0x1F612, 0x1f615],
  [0x1F61C, 0x1f61f], [0x1F620, 0x1f626], [0x1F626, 0x1f628], [0x1F628, 0x1f62c], [0x1F62E, 0x1f630], [0x1F630, 0x1f634],
  [0x1F635, 0x1f641], [0x1F641, 0x1f643], [0x1F643, 0x1f645], [0x1F645, 0x1f650], [0x1F680, 0x1f6c6], [0x1F6CB, 0x1f6d0],
  [0x1F6D1, 0x1f6d3], [0x1F6E0, 0x1f6e6], [0x1F6EB, 0x1f6ed], [0x1F6F4, 0x1f6f7], [0x1F6F7, 0x1f6f9], [0x1F910, 0x1f919],
  [0x1F919, 0x1f91f], [0x1F920, 0x1f928], [0x1F928, 0x1f930], [0x1F931, 0x1f933], [0x1F933, 0x1f93b], [0x1F93C, 0x1f93f],
  [0x1F940, 0x1f946], [0x1F947, 0x1f94c], [0x1F94D, 0x1f950], [0x1F950, 0x1f95f], [0x1F95F, 0x1f96c], [0x1F96C, 0x1f971],
  [0x1F973, 0x1f977], [0x1F97C, 0x1f980], [0x1F980, 0x1f985], [0x1F985, 0x1f992], [0x1F992, 0x1f998], [0x1F998, 0x1f9a3],
  [0x1F9B0, 0x1f9ba], [0x1F9C1, 0x1f9c3], [0x1F9D0, 0x1f9e7], [0x1F9E7, 0x1fa00],
];
const EMOJI_SINGLE = new Set([0x2328, 0x23cf, 0x24c2, 0x25b6, 0x25c0, 0x260e, 0x2611, 0x2618, 0x261d, 0x2620, 0x2626,
  0x262a, 0x2640, 0x2642, 0x2663, 0x2668, 0x267b, 0x2699, 0x26c8, 0x26ce, 0x26cf,
  0x26d1, 0x26fd, 0x2702, 0x2705, 0x270f, 0x2712, 0x2714, 0x2716, 0x271d, 0x2721, 0x2728, 0x2744, 0x2747, 0x274c,
  0x274e, 0x2757, 0x27a1, 0x27b0, 0x27bf, 0x2b50, 0x2b55, 0x3030, 0x303d, 0x3297, 0x3299, 0x1f004, 0x1f0cf, 0x1f17e,
  0x1f17f, 0x1f18e, 0x1f21a, 0x1f22f, 0x1f321, 0x1f336, 0x1f37d, 0x1f3c5, 0x1f3f7, 0x1f43f, 0x1f440, 0x1f441, 0x1f4f8,
  0x1f4fd, 0x1f4ff, 0x1f57a, 0x1f587, 0x1f590, 0x1f5a4, 0x1f5a5, 0x1f5a8, 0x1f5bc, 0x1f5e1, 0x1f5e3, 0x1f5e8, 0x1f5ef,
  0x1f5f3, 0x1f5fa, 0x1f600, 0x1f611, 0x1f615, 0x1f616, 0x1f617, 0x1f618, 0x1f619, 0x1f61a, 0x1f61b, 0x1f61f, 0x1f62c,
  0x1f62d, 0x1f634, 0x1f6d0, 0x1f6e9, 0x1f6f0, 0x1f6f3, 0x1f6f9, 0x1f91f, 0x1f930, 0x1f94c, 0x1f97a, 0x1f9c0]);

export function bodyContainsEmoji(body: string): boolean {
  for (const ch of body) {
    const cp = ch.codePointAt(0)!;
    if (EMOJI_SINGLE.has(cp) || EMOJI_RANGES.some(([a, b]) => cp >= a && cp < b)) return true;
  }
  return false;
}

/** Python `str.strip(chars)`. */
function stripChars(s: string, chars: string): string {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** The body `_apply_logic` matches (:27): no-break spaces as spaces, stripped, lowercased, without leading/trailing `.!`. */
export function botBody(html: string): string {
  return stripChars(html.replace(/ /g, ' ').trim().toLowerCase(), '.!');
}

/**
 * `_get_answer` for a message of the user in a chat with OdooBot (`channel.channel_type == "chat" and odoobot in the
 * members`, checked by the caller). The state writes are done here, in Odoo's order.
 */
export async function odoobotAnswers(env: Environment, html: string): Promise<string[]> {
  const lang = env.lang ?? 'en_US';
  const body = botBody(html);
  const user = (await env.cr.query<{ odoobot_state: string | null; odoobot_failed: boolean | null }>(
    'SELECT odoobot_state, odoobot_failed FROM res_users WHERE id = $1', [env.uid])).rows[0];
  if (!user) throw new NotPorted('OdooBot answer without the user');
  const state = user.odoobot_state;
  // `self.env.user.<field> = value`: env.user is sudo (environments.py `user`), one write each
  const set = async (vals: Record<string, unknown>): Promise<void> => write(env.sudo(), 'res.users', [env.uid], vals);
  const tr = (s: string): string => translateLang(lang, s, 'mail_bot');
  // :226-230 `_is_help_requested`
  const helpRequested = (): boolean => ['help', tr('help'), '?'].some((t) => body.includes(t)) || Boolean(user.odoobot_failed);
  if (state === 'onboarding_emoji' && bodyContainsEmoji(body)) {
    await set({ odoobot_state: 'onboarding_ping' });
    await set({ odoobot_failed: false });
    return [styled(lang, "Wow, you're a natural!%(new_line)s Use @username to mention someone and grab their attention.%(new_line)s %(bold_start)sTry mentioning me by typing%(bold_end)s %(command_start)s@OdooBot%(command_end)s in your message.")];
  }
  // :74-115 the ping, attachment, canned and help steps need mentions, attachments, canned responses or the /help
  // command, which the channel post refuses before (or, for the command, does not route here)
  if (state === 'onboarding_command' && !helpRequested()) {
    await set({ odoobot_failed: true });
    return [styled(lang, "It looks like you're not sure what to do next. Please type %(command_start)s/%(command_end)s to see the suggestions, then select %(command_start)shelp%(command_end)s and press Enter.")];
  }
  if ((state === null || state === 'idle' || state === 'not_initialized') && body.includes(tr('start the tour').toLowerCase())) {
    await set({ odoobot_state: 'onboarding_emoji' });
    return [plain(lang, 'To get started, try sending me an emoji 😊')];
  }
  if (state === 'idle' && ['❤️', tr('i love you'), tr('love'), '<p>❤️</p>', `<p>${tr('i love you')}</p>`, `<p>${tr('love')}</p>`].includes(body)) {
    return [plain(lang, "Aaaaaw that's really cute but, you know, bots don't work that way. You're too human for me! Let's keep it professional ❤️")];
  }
  if (body.includes(tr('fuck')) || body.includes('fuck')) return [plain(lang, "That's not nice! I'm a bot but I have feelings... 💔")];
  if (helpRequested() || state === 'idle') {
    return [styled(lang, "Unfortunately, I'm just a bot 😞 I don't understand that.%(new_line)sIf you need help exploring our apps, please check out %(document_link_start)sour documentation%(document_link_end)s or %(slides_link_start)sour videos%(slides_link_end)s.")];
  }
  const repeat: Record<string, string> = {
    onboarding_emoji: 'Not quite. To continue the tour, please send an emoji by typing %(command_start)s:)%(command_end)s and pressing Enter, or by clicking the %(smile_icon)s icon to pick one.',
    onboarding_ping: "Sorry, I'm not listening right now. To get my attention, %(bold_start)smention me%(bold_end)s by typing %(command_start)s@OdooBot%(command_end)s and selecting me.",
    onboarding_attachement: 'To %(bold_start)ssend an attachment%(bold_end)s, first click the %(plus_icon)s icon, then select %(paperclip_icon)s Attach files.',
    onboarding_canned: 'Not sure what you\'re doing? Please type %(command_start)s::%(command_end)s to see canned responses. Select one and press Enter.',
  };
  if (state !== null && Object.hasOwn(repeat, state)) {
    await set({ odoobot_failed: true });
    return [styled(lang, repeat[state]!)];
  }
  throw new NotPorted("OdooBot's answer chosen at random (mail_bot.py random.choice)");
}
