import { test } from "node:test";
import assert from "node:assert/strict";
import { chatterRefusal, forEachGenericThread, genericThreadModels, isCompiledThread, isGenericThread, postAccessOf, registerCompiledThread, type ThreadChatterOf } from "./thread_generic";

// a compiled thread model (compiler/oc/build.py thread_chatter, runtime threadModelKey) joins the generic chatter with
// the class attributes its builds read; a refused chatter, a build before the chatter was keyed, or two builds that
// disagree keep it out, with the reason
const chatter = { postAccess: "read", primaryEmail: "email", subjectSuggested: false, mainAttachment: false } as const;

test("a compiled thread model with a chatter is a generic thread, and the per-model RPC methods follow", () => {
  const seen: string[] = [];
  forEachGenericThread((m) => { if (m.startsWith("x_test.")) seen.push(m); });
  registerCompiledThread("x_test.ok", { chatters: () => [chatter, { ...chatter }], creationSubtype: undefined });
  assert.equal(isGenericThread("x_test.ok"), true);
  assert.equal(postAccessOf("x_test.ok"), "read");
  assert.ok(genericThreadModels().includes("x_test.ok"));
  assert.deepEqual(seen, ["x_test.ok"]);
  assert.equal(chatterRefusal("x_test.ok"), null);
});

test("a refused, unkeyed or disagreeing chatter refuses", () => {
  const cases: [string, ThreadChatterOf[], RegExp][] = [
    ["x_test.refused", [{ refused: "mixins mail.thread.cc" }], /mixins mail\.thread\.cc/],
    ["x_test.old", [undefined], /before the chatter was keyed/],
    ["x_test.two", [chatter, { ...chatter, postAccess: "write" }], /different chatters/],
  ];
  for (const [model, chatters, why] of cases) {
    registerCompiledThread(model, { chatters: () => chatters, creationSubtype: undefined });
    assert.equal(isGenericThread(model), false, model);
    assert.ok(!genericThreadModels().includes(model), model);
    assert.match(chatterRefusal(model) ?? "", why, model);
    assert.throws(() => postAccessOf(model), why, model);
  }
});

test("the hand port's own thread models keep their attributes", () => {
  assert.equal(isGenericThread("crm.lead"), true);
  assert.equal(postAccessOf("sale.order"), "read");
  assert.equal(postAccessOf("crm.lead"), "write");
  registerCompiledThread("crm.lead", { chatters: () => [{ refused: "x" }], creationSubtype: undefined });
  assert.equal(isGenericThread("crm.lead"), true);
});

// src/mail/notify.ts and write_hooks.ts notify the followers of a compiled thread model with mail's default methods;
// the hand port's own models keep their tables (NOTIFY_MODELS) and a refused chatter is not a compiled thread
test("only a compiled thread model with a chatter gets mail's default notifications", () => {
  registerCompiledThread("x_test.notify", { chatters: () => [chatter], creationSubtype: undefined });
  registerCompiledThread("x_test.notify_refused", { chatters: () => [{ refused: "_partner_unfollow_enabled" }], creationSubtype: undefined });
  assert.equal(isCompiledThread("x_test.notify"), true);
  assert.equal(isCompiledThread("x_test.notify_refused"), false);
  assert.match(chatterRefusal("x_test.notify_refused") ?? "", /_partner_unfollow_enabled/);
  assert.equal(isCompiledThread("crm.lead"), false);
  assert.equal(isCompiledThread("x_test.unknown"), false);
});
