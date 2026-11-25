/**
 * The `name_create` overrides of the installed modules (round 11 fix 3). models.py:1575-1589's generic
 * `create({_rec_name: name})` is wrong for these models: product.category's `_rec_name` is the non-stored
 * `complete_name`, so the generic path left the required `name` empty and answered a ValidationError where Odoo
 * creates the category. Listed from `grep "def name_create"` over the installed modules (res.partner's is in
 * res_partner_write.ts).
 */
import { NotPorted, ValidationError } from "../errors";
import { create } from "../orm/create";
import { and, cond } from "../orm/domain";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";
import { translate } from "./util";

async function named(env: Environment, model: string, id: number): Promise<[number, string]> {
  return [id, (await env.model(model).displayName([id])).get(id) ?? ""];
}

// product_category.py:100-103: the name is the given text, without parsing a parent out of " / "
registerOverrides("product.category", {
  nameCreate: async (env, name) => named(env, "product.category", (await create(env, "product.category", [{ name }]))[0]!),
});

// stock_location.py:273-285: "Parent/Child" creates "Child" under the location whose complete name is "Parent"
registerOverrides("stock.location", {
  nameCreate: async (env, name) => {
    if (!name) throw new NotPorted("stock.location.name_create of an empty name (super() with the complete_name)");
    const split = name.split("/");
    const [parent] = await env.model("stock.location").search(cond("complete_name", "=", split.slice(0, -1).join("/")), { limit: 1 });
    const [id] = await create(env, "stock.location", [{ name: split[split.length - 1]!, location_id: parent ?? false }]);
    return named(env, "stock.location", id!);
  },
});

// stock_quant.py:280-282: quants are not created from a name
registerOverrides("stock.quant", { nameCreate: async () => false });

// account_account.py:999-1009: only an import splits "code name"; otherwise accounts come from the chart of accounts
registerOverrides("account.account", {
  nameCreate: async (env) => {
    if ("import_file" in env.context) throw new NotPorted("account.account.name_create in an import (_split_code_name)");
    throw new ValidationError(translate(env, "Please create new accounts from the Chart of Accounts menu."));
  },
});

// project_tags.py:114-119: an existing tag of the same name (=ilike, stripped) is reused
registerOverrides("project.tags", {
  nameCreate: async (env, name) => {
    const [existing] = await env.model("project.tags").search(and([cond("name", "=ilike", name.trim())]), { limit: 1 });
    if (existing !== undefined) return named(env, "project.tags", existing);
    const [id] = await create(env, "project.tags", [{ name }]);
    return named(env, "project.tags", id!);
  },
});

// ir_model.py:472-479 creates a custom model `x_<name>`: the port's registry cannot add a model to a running database
registerOverrides("ir.model", {
  nameCreate: async () => { throw new NotPorted("ir.model.name_create (a custom model x_...)"); },
});
