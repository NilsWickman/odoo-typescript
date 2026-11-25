/**
 * `html.field.history.mixin` (odoo/addons/html_editor/models/html_field_history_mixin.py & diff_utils.py)
 * for `project.task` (`_get_versioned_fields` -> `['description']`, project_task.py:111).
 *
 * Keeps a reverse-patch revision history in `html_field_history` (JSONB, capped at 300 revisions) whenever
 * `description` changes on write, strips any caller-supplied `html_field_history` on create/write, and exposes
 * `html_field_history_get_content_at_revision` and `html_field_history_get_comparison_at_revision`.
 */
import { MissingError, NotPorted } from "../errors";
import { userInfo } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { dumps } from "../http/json";
import type { Environment } from "../orm/types";
import { registerMethod } from "../http/methods";

const HTML_FIELD_HISTORY_SIZE_LIMIT = 300;
const OPERATION_SEPARATOR = "\n";
const LINE_SEPARATOR = "<";
const PATCH_OPERATION_LINE_AT = "@";
const PATCH_OPERATION_CONTENT = ":";
const PATCH_OPERATION_ADD = "+";
const PATCH_OPERATION_REMOVE = "-";
const PATCH_OPERATION_REPLACE = "R";
const HTML_ATTRIBUTES_TO_REMOVE = ["data-last-history-commits"];

type OpcodeTag = "equal" | "replace" | "delete" | "insert";
type Opcode = [OpcodeTag, number, number, number, number];
type Match = [number, number, number];

// ----------------------------------------------------------------------------------------------------------------
// CPython difflib.SequenceMatcher(None, a, b, autojunk=False) (Python 3.12 Lib/difflib.py:310-596)
// ----------------------------------------------------------------------------------------------------------------

function findLongestMatch(
  a: readonly string[],
  b: readonly string[],
  b2j: ReadonlyMap<string, readonly number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Match {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const js = b2j.get(a[i]!);
    if (js) {
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti -= 1;
    bestj -= 1;
    bestsize += 1;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize += 1;
  }
  return [besti, bestj, bestsize];
}

function getMatchingBlocks(a: readonly string[], b: readonly string[]): Match[] {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const elt = b[i]!;
    const list = b2j.get(elt);
    if (list) list.push(i);
    else b2j.set(elt, [i]);
  }
  const la = a.length;
  const lb = b.length;
  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  const blocks: Match[] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const m = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    const [i, j, k] = m;
    if (k) {
      blocks.push(m);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  let i1 = 0, j1 = 0, k1 = 0;
  const nonAdjacent: Match[] = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2; j1 = j2; k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);
  return nonAdjacent;
}

function getOpcodes(a: readonly string[], b: readonly string[]): Opcode[] {
  let i = 0, j = 0;
  const answer: Opcode[] = [];
  for (const [ai, bj, size] of getMatchingBlocks(a, b)) {
    let tag: OpcodeTag | "" = "";
    if (i < ai && j < bj) tag = "replace";
    else if (i < ai) tag = "delete";
    else if (j < bj) tag = "insert";
    if (tag) answer.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) answer.push(["equal", ai, i, bj, j]);
  }
  return answer;
}

function getGroupedOpcodes(a: readonly string[], b: readonly string[], n = 0): Opcode[][] {
  let codes = getOpcodes(a, b);
  if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
  if (codes[0]![0] === "equal") {
    const [tag, i1, i2, j1, j2] = codes[0]!;
    codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  if (codes[codes.length - 1]![0] === "equal") {
    const [tag, i1, i2, j1, j2] = codes[codes.length - 1]!;
    codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
  }
  const nn = n + n;
  const groups: Opcode[][] = [];
  let group: Opcode[] = [];
  for (let [tag, i1, i2, j1, j2] of codes) {
    if (tag === "equal" && i2 - i1 > nn) {
      group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - n);
      j1 = Math.max(j1, j2 - n);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0]![0] === "equal")) {
    groups.push(group);
  }
  return groups;
}

// ----------------------------------------------------------------------------------------------------------------
// diff_utils.py (odoo/addons/html_editor/models/diff_utils.py)
// ----------------------------------------------------------------------------------------------------------------

const PATCH_OPS: Record<string, string> = {
  insert: PATCH_OPERATION_ADD,
  delete: PATCH_OPERATION_REMOVE,
  replace: PATCH_OPERATION_REPLACE,
};

function removeHtmlAttribute(html: string, attrs: readonly string[]): string {
  let out = html;
  for (const attr of attrs) {
    out = out.replace(new RegExp(` ${attr}="[^"]*"`, "g"), "");
  }
  return out;
}

function formatLineIndex(start: number, end: number): string {
  const length = end - start;
  const s = length ? start : start - 1;
  if (length <= 1) return `${PATCH_OPERATION_LINE_AT}${s}`;
  return `${PATCH_OPERATION_LINE_AT}${s},${s + length - 1}`;
}

export function generatePatch(newContentIn: string, oldContentIn: string): string {
  const newContent = removeHtmlAttribute(newContentIn, HTML_ATTRIBUTES_TO_REMOVE).replace(/\n/g, "");
  const oldContent = removeHtmlAttribute(oldContentIn, HTML_ATTRIBUTES_TO_REMOVE).replace(/\n/g, "");
  const newLines = newContent.split(LINE_SEPARATOR);
  const oldLines = oldContent.split(LINE_SEPARATOR);
  const ops: string[] = [];
  for (const group of getGroupedOpcodes(newLines, oldLines, 0)) {
    const patchContentLine: string[] = [];
    const first = group[0]!;
    const last = group[group.length - 1]!;
    let patchOp = formatLineIndex(first[1], last[2]);
    if (group.some(([tag]) => tag === "replace" || tag === "delete")) {
      for (const [tag] of group) {
        if (tag !== "insert" && tag !== "equal" && tag !== "replace") {
          patchOp = PATCH_OPS[tag]! + patchOp;
        }
      }
    }
    if (group.some(([tag]) => tag === "replace" || tag === "insert")) {
      for (const [tag, , , j1, j2] of group) {
        if (tag !== "delete" && tag !== "equal") {
          patchOp = PATCH_OPS[tag]! + patchOp;
          for (let j = j1; j < j2; j++) patchContentLine.push(oldLines[j]!);
        }
      }
    }
    if (patchContentLine.length) {
      ops.push(`${patchOp}${PATCH_OPERATION_CONTENT}${LINE_SEPARATOR}${patchContentLine.join(LINE_SEPARATOR)}`);
    } else {
      ops.push(patchOp);
    }
  }
  return ops.join(OPERATION_SEPARATOR);
}

export function applyPatch(initialContentIn: string, patch: string): string {
  if (!patch) return initialContentIn;
  const initialContent = removeHtmlAttribute(initialContentIn.replace(/\n/g, ""), HTML_ATTRIBUTES_TO_REMOVE);
  const content = initialContent.split(LINE_SEPARATOR);
  const operations = patch.split(OPERATION_SEPARATOR).reverse();
  for (const operation of operations) {
    const parts = operation.split(LINE_SEPARATOR);
    const metadata = parts[0]!;
    const patchLines = parts.slice(1).reverse();
    const metaSplit = metadata.split(PATCH_OPERATION_LINE_AT);
    const opType = metaSplit[0]!;
    const rangeStr = (metaSplit[1] ?? "").split(PATCH_OPERATION_CONTENT)[0]!;
    const indexes = rangeStr.split(",");
    const startIndex = indexes.length ? Number.parseInt(indexes[0]!, 10) : 0;
    const endIndex = indexes.length > 1 ? Number.parseInt(indexes[1]!, 10) : startIndex;
    if (endIndex > startIndex) {
      for (let idx = endIndex; idx > startIndex; idx--) {
        if (opType === PATCH_OPERATION_REMOVE || opType === PATCH_OPERATION_REPLACE) {
          content.splice(idx, 1);
        }
      }
    }
    if (opType === PATCH_OPERATION_ADD || opType === PATCH_OPERATION_REPLACE) {
      for (const line of patchLines) content.splice(startIndex + 1, 0, line);
    }
    if (opType === PATCH_OPERATION_REMOVE || opType === PATCH_OPERATION_REPLACE) {
      content.splice(startIndex, 1);
    }
  }
  return content.join(LINE_SEPARATOR);
}

const HTML_TAG_ISOLATION_RE = /^([^>]*>)(.*)$/;
const EMPTY_OPERATION_TAG_RE = /<(added|removed)><\/(added|removed)>/;
const SAME_TAG_REPLACE_FIXER_RE = /<\/added><(?:[^/>]|(?:><))+><removed>/g;
const UNNECESSARY_REPLACE_FIXER_RE = /<added>([^<](?!<\/added>)*)<\/added><removed>([^<](?!<\/removed>)*)<\/removed>/g;

export function generateComparison(newContentIn: string, oldContentIn: string): string {
  const newContent = removeHtmlAttribute(newContentIn, HTML_ATTRIBUTES_TO_REMOVE);
  const oldContent = removeHtmlAttribute(oldContentIn, HTML_ATTRIBUTES_TO_REMOVE);
  if (newContent === oldContent) return newContent;
  const patch = generatePatch(newContent, oldContent);
  const comparison = newContent.split(LINE_SEPARATOR);
  const operations = patch.split(OPERATION_SEPARATOR).reverse();
  for (const operation of operations) {
    const parts = operation.split(LINE_SEPARATOR);
    const metadata = parts[0]!;
    const patchLines = parts.slice(1);
    const metaSplit = metadata.split(PATCH_OPERATION_LINE_AT);
    const opType = metaSplit[0]!;
    const rangeStr = (metaSplit[1] ?? "").split(PATCH_OPERATION_CONTENT)[0]!;
    const indexes = rangeStr.split(",");
    const startIndex = indexes.length ? Number.parseInt(indexes[0]!, 10) : 0;
    const endIndex = indexes.length > 1 ? Number.parseInt(indexes[1]!, 10) : startIndex;

    if (opType === PATCH_OPERATION_REPLACE) {
      for (let i = 0; i < patchLines.length; i++) {
        const currentIndex = startIndex + i;
        if (currentIndex > endIndex) break;
        const currentLine = comparison[currentIndex]!;
        const currentTag = currentLine.split(">")[0]!;
        const lineTag = patchLines[i]!.split(">")[0]!;
        if (currentLine.endsWith(">") && (currentTag === lineTag || currentTag.split(" ")[0] === lineTag.split(" ")[0])) {
          comparison[currentIndex] = "delete_me>";
        }
      }
    }
    patchLines.reverse();
    for (let idx = endIndex; idx >= startIndex; idx--) {
      if (opType === PATCH_OPERATION_REMOVE || opType === PATCH_OPERATION_REPLACE) {
        const flagged = comparison[idx]!.replace(HTML_TAG_ISOLATION_RE, "$1<removed>$2</removed>");
        if (!EMPTY_OPERATION_TAG_RE.test(flagged)) comparison[idx] = flagged;
      }
    }
    if (opType === PATCH_OPERATION_ADD) {
      for (const line of patchLines) {
        const flagged = line.replace(HTML_TAG_ISOLATION_RE, "$1<added>$2</added>");
        comparison.splice(startIndex + 1, 0, EMPTY_OPERATION_TAG_RE.test(flagged) ? line : flagged);
      }
    }
    if (opType === PATCH_OPERATION_REPLACE) {
      for (const line of patchLines) {
        const flagged = line.replace(HTML_TAG_ISOLATION_RE, "$1<added>$2</added>");
        if (!EMPTY_OPERATION_TAG_RE.test(flagged)) {
          comparison.splice(startIndex, 0, flagged);
        } else if (line.split(">")[0] !== comparison[startIndex]!.split(">")[0] || line.startsWith("/")) {
          comparison.splice(startIndex, 0, line);
        }
      }
    }
  }
  let out = comparison.join(LINE_SEPARATOR)
    .replace(SAME_TAG_REPLACE_FIXER_RE, "</added><removed>")
    .replaceAll("<delete_me>", "");
  for (const m of [...out.matchAll(UNNECESSARY_REPLACE_FIXER_RE)]) {
    if (m[1] === m[2]) out = out.replaceAll(m[0], m[1]!);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------------
// HtmlFieldHistoryMixin hooks & RPC methods on `project.task`
// ----------------------------------------------------------------------------------------------------------------

interface Revision {
  patch: string;
  revision_id: number;
  create_date: string;
  create_uid: number;
  create_user_name: string;
}

/** `self.env.cr.now().isoformat()`: UTC transaction timestamp with 6 microsecond digits (omitted if 0). */
async function crNowIsoformat(env: Environment): Promise<string> {
  const ts = (await env.cr.query<{ ts: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS ts")).rows[0]!.ts;
  return ts.endsWith(".000000") ? ts.slice(0, -7) : ts;
}

registerHooks("project.task", {
  write: [{
    // html_field_history_mixin.py:42-46
    beforeCreate: async (_env, valsList) => {
      for (const vals of valsList) delete vals["html_field_history"];
    },
    // html_field_history_mixin.py:48-51
    beforeWrite: async (_env, _ids, vals) => {
      delete vals["html_field_history"];
    },
    // html_field_history_mixin.py:66-111
    afterWrite: async (env, ids, vals, old) => {
      if (!("description" in vals) || !ids.length) return;
      const rows = (await env.cr.query<{ id: number; description: string | null; html_field_history: Record<string, Revision[]> | null }>(
        "SELECT id, description, html_field_history FROM project_task WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
      let nowIso: string | null = null;
      let userName: string | null = null;
      for (const row of rows) {
        const oldVal = old.get(row.id)?.["description"];
        const oldContent = typeof oldVal === "string" ? oldVal : "";
        const newContent = row.description ?? "";
        if (newContent === oldContent) continue;
        if (nowIso === null) nowIso = await crNowIsoformat(env);
        if (userName === null) userName = (await userInfo(env)).name;
        const historyRevs: Record<string, Revision[]> = row.html_field_history && typeof row.html_field_history === "object" && !Array.isArray(row.html_field_history)
          ? { ...row.html_field_history } : {};
        const revs = Array.isArray(historyRevs["description"]) ? [...historyRevs["description"]] : [];
        const revisionId = revs.length ? Number(revs[0]!.revision_id) + 1 : 1;
        revs.unshift({
          patch: generatePatch(newContent, oldContent),
          revision_id: revisionId,
          create_date: nowIso,
          create_uid: env.uid,
          create_user_name: userName,
        });
        historyRevs["description"] = revs.slice(0, HTML_FIELD_HISTORY_SIZE_LIMIT);
        await env.cr.query("UPDATE project_task SET html_field_history = $2::jsonb WHERE id = $1", [row.id, dumps(historyRevs)]);
      }
    },
  }],
});

async function contentAtRevision(env: Environment, ids: readonly number[], fieldName: string, revisionId: number): Promise<{ current: string; restored: string }> {
  if (ids.length !== 1) throw new NotPorted(`html_field_history_get_content_at_revision on ${ids.length} records`);
  const id = ids[0]!;
  await env.model("project.task").checkAccess([id], "read");
  const row = (await env.cr.query<{ description: string | null; html_field_history: Record<string, Revision[]> | null }>(
    "SELECT description, html_field_history FROM project_task WHERE id = $1", [id])).rows[0];
  if (!row) throw new MissingError(`Record does not exist or has been deleted.\n(Record: project.task(${id},), User: ${env.uid})`);
  if (fieldName !== "description") throw new NotPorted(`html_field_history on field ${fieldName}`);
  const current = row.description ?? "";
  // `self.html_field_history[field_name]`: no history (TypeError) or none for the field (KeyError) raise in Odoo
  const history = row.html_field_history;
  if (history === null || typeof history !== "object" || !Object.hasOwn(history, fieldName)) {
    throw new NotPorted(`html_field_history_get_content_at_revision without a ${fieldName} history (${history === null ? "TypeError" : "KeyError"})`);
  }
  const allRevs = history[fieldName] ?? [];
  let content = current;
  for (const rev of allRevs) {
    if (rev.revision_id >= revisionId) content = applyPatch(content, rev.patch);
  }
  return { current, restored: content };
}

registerMethod("project.task", "html_field_history_get_content_at_revision", async (env, ids, args, kwargs) => {
  const fieldName = String(args[0] ?? kwargs["field_name"] ?? "");
  const revisionId = Number(args[1] ?? kwargs["revision_id"]);
  return (await contentAtRevision(env, ids ?? [], fieldName, revisionId)).restored;
}, { apiModel: false, readonly: true });

registerMethod("project.task", "html_field_history_get_comparison_at_revision", async (env, ids, args, kwargs) => {
  const fieldName = String(args[0] ?? kwargs["field_name"] ?? "");
  const revisionId = Number(args[1] ?? kwargs["revision_id"]);
  const { current, restored } = await contentAtRevision(env, ids ?? [], fieldName, revisionId);
  return generateComparison(restored, current);
}, { apiModel: false, readonly: true });
