import { test } from "node:test";
import assert from "node:assert/strict";
import { messagePreview, notificationLayout, userAssignedBody } from "./mail_notify_layout";

// Expected values: the C3 reference's assignment notification (harness/corpus/runtime/ref/frozen-2026-10-28/C3/db_diff.json,
// mail_message 2546 body and mail_mail 338 body_html with web.base.url masked as <base_url>).
test("assignment notification body and layout", () => {
  const body = userAssignedBody("Marc Demo", "Lead", "Quote for 12 Tables");
  assert.equal(body, '<span><span>Dear Marc Demo,</span>\n    <br><br>\n    <span style="margin-top:8px">You have been assigned to the Lead Quote for 12 Tables.</span>\n    <br></span>');
  assert.equal(messagePreview(body), "Dear Marc Demo, You have been assigned to the Lead Quote for 12 Tables.");
  const html = notificationLayout({
    lang: "en_US", subtypeInternal: true, preview: messagePreview(body)!, buttonUrl: "http://h/mail/view?model=crm.lead&res_id=13",
    buttonTitle: "View Lead", subtitles: ["Quote for 12 Tables", "Deadline: 11/27/2026"], body,
    signature: "<div>-- <br/><div>Mitchell Admin</div></div>", primaryColor: "#FFFFFF", secondaryColor: "#875A7B",
  });
  assert.ok(html.startsWith('\n<html lang="en_US">'));
  assert.ok(html.includes('href="http://h/mail/view?model=crm.lead&amp;res_id=13"'));
});
