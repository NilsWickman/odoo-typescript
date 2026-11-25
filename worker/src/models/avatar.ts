/**
 * `avatar.mixin` (odoo/odoo/addons/base/models/avatar_mixin.py) and its res.partner override
 * (odoo/odoo/addons/base/models/res_partner.py:425-459): `avatar_128` is the stored `image_128` attachment, else a
 * generated SVG with the first letter of the name on a color seeded from name and creation time, else a placeholder
 * PNG chosen by company/address type.
 */
import type { BinaryValue } from "../orm/types";
import { binaryBytes } from "./binary";
import { htmlEscape, pyFloatReprSimple, sha512Hex } from "./util";

/** `get_random_ui_color_from_seed` (avatar_mixin.py:9-15): COLOR_XL of web/static/src/core/colors/colors.js. */
const AVATAR_BG_COLORS = [
  "#4EA7F2", "#3188E6", "#056BD9", "#155193", "#A76DBC", "#7F4295", "#6D2387", "#4F1565", "#EA6175", "#CE4257",
  "#982738", "#791B29", "#43C5B1", "#00A78D", "#0E8270", "#105F53", "#F4A261", "#F48935", "#BE5D10", "#7D380D",
  "#8481DD", "#5752D1", "#3A3580", "#26235F", "#A4A8B6", "#7E8290", "#545B70", "#3F4250", "#FFD86D", "#FFBC2C",
  "#C08A16", "#936A12",
];

export function getRandomUiColorFromSeed(seed: string): string {
  const hashed = sha512Hex(Buffer.from(seed, "utf8"));
  const num = BigInt(`0x${hashed}`);
  return AVATAR_BG_COLORS[Number(num % BigInt(AVATAR_BG_COLORS.length))] as string;
}

/**
 * The seed of `_avatar_generate_svg` (avatar_mixin.py:75): `f"{name}{create_date.timestamp() if create_date else ''}"`.
 * `create_date` is a naive datetime in UTC (Odoo runs with TZ=UTC), so `timestamp()` is the UTC epoch as a Python
 * float: "1793129749.953594", or "1793129749.0" when the microseconds are zero.
 */
export function avatarSeed(name: string, createDateUtc: Date | null, microseconds: number): string {
  if (createDateUtc === null) return name;
  const seconds = Math.floor(createDateUtc.getTime() / 1000);
  const ts = seconds + microseconds / 1e6;
  return `${name}${pyFloatReprSimple(ts)}`;
}

/** `_avatar_generate_svg` (avatar_mixin.py:73-83): the exact template, filename `avatar_<initial>.svg`. */
export function generateAvatarSvg(name: string, seed: string): BinaryValue {
  const initial = htmlEscape(Array.from(name)[0]?.toUpperCase() ?? "");
  const bgcolor = getRandomUiColorFromSeed(seed);
  const svg = '<?xml version="1.0" encoding="UTF-8" ?>'
    + '<svg height="180" width="180" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
    + `<rect fill="${bgcolor}" height="180" width="180"/>`
    + `<text fill="#ffffff" font-size="96" text-anchor="middle" x="90" y="125" font-family="sans-serif">${initial}</text>`
    + "</svg>";
  return binaryBytes(Buffer.from(svg, "utf8"), `avatar_${initial}.svg`, "image/svg+xml");
}

/** `generate_text_avatar_svg(text, seed)` (avatar_mixin.py:18-33), used by discuss.channel avatars. */
export function generateTextAvatarSvg(text: string, seed: string): BinaryValue {
  const bgcolor = getRandomUiColorFromSeed(seed);
  const fontSize = Array.from(text).length <= 1 ? 104 : 86;
  const svg = "<?xml version='1.0' encoding='UTF-8' ?>"
    + "<svg height='180' width='180' xmlns='http://www.w3.org/2000/svg'>"
    + `<rect fill='${bgcolor}' height='180' width='180'/>`
    + `<text fill='#ffffff' font-size='${fontSize}' font-weight='bold' text-anchor='middle' x='90' y='124' font-family='sans-serif'>${htmlEscape(text)}</text>`
    + "</svg>";
  return binaryBytes(Buffer.from(svg, "utf8"), "", "image/svg+xml");
}

/** `res.partner._avatar_get_placeholder_path` (res_partner.py:450-459) over `avatar.mixin`'s (avatar_mixin.py:85). */
export function partnerPlaceholderPath(isCompany: boolean, type: string | null): string {
  if (isCompany) return "base/static/img/avatar_placeholder_company.png";
  if (type === "delivery") return "base/static/img/avatar_placeholder_delivery.png";
  if (type === "invoice") return "base/static/img/avatar_placeholder_invoice.png";
  if (type === "other") return "base/static/img/avatar_placeholder_other.png";
  return "base/static/img/avatar_grey.png";
}

const placeholderCache = new Map<string, BinaryValue>();

/** `_avatar_get_placeholder` (avatar_mixin.py:88-90): the file's bytes with filename 'avatar.svg' (sic). */
export async function placeholderValue(path: string): Promise<BinaryValue> {
  const cached = placeholderCache.get(path);
  if (cached !== undefined) return cached;
  const { PLACEHOLDERS } = await import("./avatar_placeholders");
  const b64 = PLACEHOLDERS[path];
  if (b64 === undefined) throw new Error(`no placeholder image for ${path}`);
  const value = binaryBytes(Buffer.from(b64, "base64"), "avatar.svg", "image/png");
  placeholderCache.set(path, value);
  return value;
}

export interface PartnerAvatarInput {
  readonly id: number;
  readonly name: string | null;
  readonly type: string | null;
  readonly isCompany: boolean;
  /** `any(not u.share for u in partner.user_ids)` over the active users (x2many values are active-filtered). */
  readonly hasInternalUser: boolean;
  readonly createDateUtc: Date | null;
  readonly createMicroseconds: number;
  readonly image: BinaryValue | null;
}

/**
 * `res.partner._compute_avatar` (res_partner.py:439-448) over `avatar.mixin._compute_avatar` (avatar_mixin.py:47-55):
 * contacts and partners with an internal user get the image, else the generated SVG (when named), else the
 * placeholder; other partners get the image or the placeholder for their type.
 */
export async function partnerAvatar(p: PartnerAvatarInput): Promise<BinaryValue> {
  if (p.image !== null) return p.image;
  const internal = p.type === "contact" || p.hasInternalUser;
  if (internal && p.id > 0 && p.name !== null && p.name !== "") {
    return generateAvatarSvg(p.name, avatarSeed(p.name, p.createDateUtc, p.createMicroseconds));
  }
  return placeholderValue(partnerPlaceholderPath(p.isCompany, p.type));
}
