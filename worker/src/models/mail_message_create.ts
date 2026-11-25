/**
 * `mail.message.create` (mail/models/mail_message.py:769-857) through the ORM, as data files and the chart loader
 * create messages (account_demo.py:489-522): the author's email, the message id and the reply-to are filled before
 * the insert. message_post builds complete values itself (src/mail/message.ts insertMessages). Base64 images in the
 * body, a reply-to through an alias domain and the non-internal author branch refuse.
 */
import { NotPorted } from "../errors";
import { computeAuthor, trackingMessageId } from "../mail/message";
import { registerOverrides } from "../orm/write";
import { userHasGroup } from "../web/groups";

registerOverrides("mail.message", {
  create: async (env, valsList, next) => {
    const list = valsList.map((v) => ({ ...v }));
    for (const values of list) {
      // :771-774 a portal or public author is dropped
      if (!env.su && !(await userHasGroup(env, "base.group_user"))) throw new NotPorted("mail.message create by a non-internal user");
      for (const k of ["default_model", "default_res_id", "default_author_id"]) {
        if (env.context[k] !== undefined) throw new NotPorted(`mail.message create with ${k} in the context`);
      }
      // :775-777 `_message_compute_author(author_id)`: the author's formatted email (the user's partner without one)
      if (!("email_from" in values)) {
        const author = values["author_id"];
        const [, emailFrom] = await computeAuthor(env, typeof author === "number" && author ? author : author === false ? null : undefined);
        values["email_from"] = emailFrom;
      }
      const model = values["model"], resId = values["res_id"];
      // :1527-1532 `_is_thread_message`: a model other than mail.thread and a res_id
      const thread = typeof model === "string" && model !== "mail.thread" && Boolean(resId);
      // :1516-1525 `_get_message_id`
      if (!values["message_id"]) {
        values["message_id"] = values["reply_to_force_new"] === true ? trackingMessageId("reply_to") : thread ? trackingMessageId(`${String(resId)}-${model as string}`) : trackingMessageId("private");
      }
      // :1502-1513 `_get_reply_to`: `_notify_get_reply_to(default=email_from)` (models.py:610-680) is the default without
      // alias domains (a company's catchall)
      if (!("reply_to" in values)) {
        if ((await env.cr.query("SELECT 1 FROM mail_alias_domain LIMIT 1")).rows.length) throw new NotPorted("mail.message reply-to through an alias domain (_notify_get_reply_to)");
        values["reply_to"] = values["email_from"];
      }
      // :783-785 empty attachments are dropped
      if ("attachment_ids" in values && !(Array.isArray(values["attachment_ids"]) && values["attachment_ids"].length)) delete values["attachment_ids"];
      // :786-813 base64 images become attachments
      if (typeof values["body"] === "string" && /src=["']data:image\//.test(values["body"])) throw new NotPorted("mail.message body with base64 images (mail_message.py:787)");
    }
    // :818-852 the attachments of other documents are checked for read access (the superuser passes)
    if (!env.su && list.some((v) => Array.isArray(v["attachment_ids"]) && v["attachment_ids"].length)) {
      throw new NotPorted("mail.message create with attachments by a non-superuser (their read access)");
    }
    return next(env, list);
  },
});
