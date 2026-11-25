/**
 * The output method of the Html fields declared with `sanitize='email_outgoing'` (the only spelling of
 * sanitize_tags=False with sanitize_attributes=False, fields_textual.py:620-640), as this Odoo commit resolves it:
 * gen/out/html_sanitize.json from gen/html_sanitize.py, which checks the rule on every Html field of the registry.
 * 'xml' up to Odoo 9710d237f (2026-09-18), 'html' after it; the other Html fields keep the class default 'html'.
 */
import gen from "../../gen/out/html_sanitize.json" with { type: "json" };
import { NotPorted } from "../errors";

const method = gen.email_outgoing.sanitize_output_method;
if (method !== "xml" && method !== "html") throw new NotPorted(`html_sanitize.json: email_outgoing output method ${String(method)}`);

/** Whether `email_outgoing` fields serialise as XML (lxml's xml method) rather than HTML. */
export const EMAIL_OUTGOING_XML: boolean = method === "xml";
