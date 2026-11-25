/**
 * quotation.document (odoo/addons/sale_pdf_quote_builder/models/quotation_document.py): creating one, or writing its
 * PDF (`raw`/`datas`), recomputes `form_field_ids` from the PDF's form fields (`_compute_form_field_ids` :74-83 ->
 * sale_pdf_form_field.py `_create_or_update_form_fields_on_pdf_records`, PyPDF2) and `_check_pdf_validity` (:62-72):
 * not ported, refused rather than created without the parsing (and its ValidationError).
 */
import { NotPorted } from "../errors";
import { checkModelAccess } from "../orm/access";
import { registerOverrides } from "../orm/write";

registerOverrides("quotation.document", {
  create: async (env) => {
    // BaseModel.create checks the model access first (models.py:4113): its AccessError comes before the parsing
    if (!env.su) await checkModelAccess(env, env.reg.model("quotation.document"), "create");
    throw new NotPorted("quotation.document create (PDF form field parsing, sale_pdf_form_field.py)");
  },
  write: async (env, ids, vals, next) => {
    if ("raw" in vals || "datas" in vals || "ir_attachment_id" in vals) {
      throw new NotPorted("quotation.document PDF write (PDF form field parsing, sale_pdf_form_field.py)");
    }
    await next(env, ids, vals);
  },
});
