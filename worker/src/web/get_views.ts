/** BaseModel.get_views/get_view, base/models/ir_ui_view.py:2964-3280. */
import { NotPorted, OdooError } from "../errors";
import type { Environment, RecordValues } from "../orm/types";
import { userInfo } from "../orm/env";
import { and, cond } from "../orm/domain";
import { combinedArchTree } from "../views/combine";
import { postprocess } from "../views/postprocess";
import { addNext, detach, insert, iter, type Element } from "../xml/node";
import { serializeXml } from "../xml/serialize";
import { parseXml } from "../xml/parse";
import { hasModelAccess, userGroupIds } from "./groups";
import { registerBaseMethod } from "./register";
import * as priv from "../orm/dispatch_gen";

type Options=Record<string,unknown>;
interface View { arch:string; id:number|false; model:string; toolbar?:Record<string,RecordValues[]>; filters?:RecordValues[] }

export async function loadView(env:Environment,model:string,type:string,id?:number):Promise<{arch:Element;id:number|false}> {
  // ir_ui_view.py:3178 `_get_view`, a hook: the models' own (res.company, res.partner, below) are inlined; a module's
  // override (l10n_fr_account: account.move's shipping address without its groups for a French company) refuses
  if(await priv.account_move._get_view.overriddenOn(env, model)) throw new NotPorted(`the ${type} view of ${model} with a module's _get_view`);
  if(!id) {
    const ref=env.context[`${type}_view_ref`];
    if(typeof ref==='string' && ref.includes('.')) {
      const dot=ref.indexOf('.');
      id=(await env.cr.query<{res_id:number}>("SELECT res_id FROM ir_model_data WHERE model='ir.ui.view' AND module=$1 AND name=$2",[ref.slice(0,dot),ref.slice(dot+1)])).rows[0]?.res_id;
    }
    if(!id) id=(await env.cr.query<{id:number}>("SELECT id FROM ir_ui_view WHERE model=$1 AND type=$2 AND mode='primary' AND active ORDER BY priority,name,id LIMIT 1",[model,type])).rows[0]?.id;
  }
  if(!id && type==='search') {
    // ir_ui_view.py:2875 _get_default_search_view: one field on _rec_name_fallback(), string=_description (untranslated)
    const def=env.reg.model(model);
    const esc=(v:string)=>v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    return {arch:parseXml(`<search string="${esc(def.description)}"><field name="${esc(def.recName??'id')}"/></search>`),id:false};
  }
  if(!id && type==='activity' && env.reg.model(model).hasActivities) {
    // mail/models/models.py:747-756 _get_default_activity_view: one field (_rec_name_fallback) in an activity-box
    const def=env.reg.model(model);
    const esc=(v:string)=>v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    const recName=def.recName && def.fields.has(def.recName) ? def.recName : 'id';
    return {arch:parseXml(`<activity string="${esc(def.description)}"><templates><div t-name="activity-box"><field name="${esc(recName)}"/></div></templates></activity>`),id:false};
  }
  if(!id && (type==='kanban' || type==='graph')) {
    // ir_ui_view.py:2904-2924 _get_default_kanban_view / _get_default_graph_view: the _rec_name_fallback() field
    const def=env.reg.model(model);
    const esc=(v:string)=>v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    const recName=def.recName && def.fields.has(def.recName) ? def.recName : 'id';
    const xml=type==='kanban'
      ? `<kanban string="${esc(def.description)}"><templates><t t-name="card"><field name="${esc(recName)}"/></t></templates></kanban>`
      : `<graph string="${esc(def.description)}"><field name="${esc(recName)}"/></graph>`;
    return {arch:parseXml(xml),id:false};
  }
  if(!id && type==='form') {
    // ir_ui_view.py:2832-2872 _get_default_form_view: every field but the magic columns (and a readonly
    // display_name, and non-stored non-image binaries) in two balanced groups; x2many/text/html on their own line
    const def=env.reg.model(model);
    const esc=(v:string)=>v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    const magic=new Set(['id','create_uid','create_date','write_uid','write_date']);
    const sheet:string[]=[];let main:string[]=[];let left:string[]=[];let right:string[]=[];
    const group=(items:string[])=>`<group>${items.join('')}</group>`;
    for(const [fname,field] of def.fields) {
      if(magic.has(fname) || (fname==='display_name' && field.readonly)) continue;
      if(field.type==='binary' && !field.store) continue;
      const node=`<field name="${esc(fname)}"/>`;
      if(['one2many','many2many','text','html'].includes(field.type)) {
        if(left.length) {main.push(group(left));left=[];}
        if(right.length) {main.push(group(right));right=[];}
        if(main.length) {sheet.push(group(main));main=[];}
        sheet.push(group([node]));
      } else if(left.length>right.length) right.push(node); else left.push(node);
    }
    if(left.length) main.push(group(left));
    if(right.length) main.push(group(right));
    sheet.push(group(main));
    sheet.push('<group><separator/></group>');
    return {arch:parseXml(`<form><sheet string="${esc(def.description)}">${sheet.join('')}</sheet></form>`),id:false};
  }
  // The default views are the same in every language: their only text is the class attribute `_description`, which
  // Odoo does not translate (model_classes.py:285-296), and the field labels come later from fields_get.
  // orm models.py `_get_default_list_view` / `_get_default_search_view`: one field, the record name (`_rec_name_fallback`)
  if(!id && (type==='list' || type==='search')) {
    const def=env.reg.model(model);
    const esc=(v:string)=>v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    return {arch:parseXml(`<${type} string="${esc(def.description)}"><field name="${esc(def.recName ?? 'id')}"/></${type}>`),id:false};
  }
  if(!id) throw new NotPorted(`default ${type} view generation for ${model}`);
  let arch=await combinedArchTree(env.cr,id,new Set(),{lang:env.lang??'en_US'});
  // FormatAddressMixin._view_get_address, res_partner.py:163-208.
  if(type==='form' && env.reg.model(model).formatAddress && !env.context['no_address_format']) {
    const country=(await env.cr.query<{address_view_id:number|null;address_format:string|null}>(
      `SELECT c.address_view_id,c.address_format FROM res_company co JOIN res_partner p ON p.id=co.partner_id
       LEFT JOIN res_country c ON c.id=p.country_id WHERE co.id=$1`,[await env.company()])).rows[0];
    const addresses=[...iter(arch,'div')].filter(n=>n.attrib.get('class')?.split(/\s+/).includes('o_address_format'));
    if(country?.address_view_id) {
      const viewModel=(await env.cr.query<{model:string|null}>('SELECT model FROM ir_ui_view WHERE id=$1',[country.address_view_id])).rows[0]?.model;
      if(!viewModel || viewModel===model) for(const node of addresses) {
        if(model!=='res.partner') throw new NotPorted(`address subview validation for ${model}`);
        const sub=(await loadView(env.withContext({...env.context,no_address_format:true}),'res.partner','form',country.address_view_id)).arch;
        const replacement=[...iter(sub,'div')].find(n=>n.attrib.get('class')==='o_address_format')??sub;
        const parent=node.parent;if(!parent) {arch=replacement;continue;}
        const index=parent.children.indexOf(node);detach(node);insert(parent,index,replacement);
      }
    } else if(country?.address_format) {
      const line=country.address_format.split('\n').find(l=>l.includes('city'));
      if(line) {
        const fields=[...line.matchAll(/%\((\w+)\)s/g)].map(m=>m[1]!).filter(n=>['street','street2','zip','city','state_id','country_id','state_code','state_name'].includes(n)).map(n=>['state_code','state_name'].includes(n)?'state_id':n);
        for(const node of addresses) {
          let current=[...iter(node,'field')].find(n=>n.attrib.get('name')===fields[0]);
          const remaining=new Set(['zip','city','state_id']);remaining.delete(fields[0]!);
          for(const name of fields.slice(1)) {
            const previous=current;current=[...iter(node,'field')].find(n=>n.attrib.get('name')===name);
            if(previous&&current) addNext(previous,current);remaining.delete(name);
          }
          if(remaining.size>1) throw new NotPorted('address-format unordered residual fields');
          for(const name of remaining) {const previous=current;current=[...iter(node,'field')].find(n=>n.attrib.get('name')===name);if(previous&&current) addNext(previous,current);}
        }
      }
    }
  }
  // base res_company.py:315-321 _get_view (`_get_company_root_delegated_field_names`, account company.py:401-407), then
  // partner_autocomplete res_company.py:28-35
  if(model==='res.company') {
    const delegated=new Set(['currency_id','fiscalyear_last_day','fiscalyear_last_month','account_storno','tax_exigibility']);
    if(!env.reg.model(model).fields.has('account_storno')) throw new NotPorted('res.company form view without account');
    for(const node of iter(arch,'field')) if(delegated.has(node.attrib.get('name')??'')) node.attrib.set('readonly','parent_id != False');
    if(type==='form' && env.reg.model(model).modules?.includes('partner_autocomplete')) {
      for(const node of iter(arch,'field')) if(['name','vat','duns'].includes(node.attrib.get('name')??'')) node.attrib.set('widget','field_partner_autocomplete');
    }
  }
  // partner_autocomplete/models/res_partner.py:231 _get_view.
  if(model==='res.partner' && type==='form' && env.reg.model(model).modules?.includes('partner_autocomplete')) {
    for(const node of iter(arch,'field')) if(['name','vat','duns'].includes(node.attrib.get('name')??'')) node.attrib.set('widget','field_partner_autocomplete');
  }
  return {arch,id};
}

/** ir.actions.actions._get_bindings/get_bindings, ir_actions.py:156-212. */
async function bindings(env:Environment,model:string):Promise<Record<string,RecordValues[]>> {
  const rows=(await env.cr.query<{id:number;type:string;binding_type:string}>(
    'SELECT a.id,a.type,a.binding_type FROM ir_actions a JOIN ir_model m ON a.binding_model_id=m.id WHERE m.model=$1 ORDER BY a.id',[model])).rows;
  const result:Record<string,RecordValues[]>={},groups=await userGroupIds(env);
  // Odoo reads each action alone (`browse(action_id).read(fields)`), behind the ormcache of `_get_bindings`; on a new
  // isolate that was four statements per action (52 of a cold sale.order get_views, docs/accept/C2.md). Read per
  // action model in one `read` instead: the same values per record, a deleted action absent in both.
  const byType=new Map<string,number[]>();
  for(const row of rows) {const ids=byType.get(row.type)??[];ids.push(row.id);byType.set(row.type,ids);}
  const read=new Map<string,Map<number,RecordValues>>();
  for(const [type,ids] of byType) {
    const actionModel=env.sudo().model(type);
    const fields=['name','binding_view_types',...['group_ids','res_model','sequence','domain'].filter(n=>actionModel.def.fields.has(n))];
    read.set(type,new Map((await actionModel.read(ids,fields)).map(r=>[Number(r['id']),r])));
  }
  for(const row of rows) {
    const action=read.get(row.type)?.get(row.id);if(!action) continue;
    const actionGroups=action['group_ids'];delete action['group_ids'];
    // res_users.py:1195-1212 has_group: base.group_no_one only counts in debug mode
    const noOne=await env.reg.xmlid(env.cr,'base.group_no_one');
    if(Array.isArray(actionGroups) && actionGroups.length && !actionGroups.some(g=>typeof g==='number'&&groups.has(g)&&(g!==noOne||Boolean(env.debug)))) continue;
    const resModel=action['res_model'];delete action['res_model'];
    if(typeof resModel==='string' && (!env.reg.models.has(resModel)||!await hasModelAccess(env,resModel,'read'))) continue;
    if(!action['domain']) delete action['domain'];
    (result[row.binding_type]??=[]).push(action);
  }
  result['action']?.sort((a,b)=>Number(a['sequence']??0)-Number(b['sequence']??0));
  return result;
}

/** ir.filters.get_filters: users' default context, public and private filters. */
async function filters(env:Environment,model:string,options:Options):Promise<RecordValues[]> {
  const user=await userInfo(env);
  const filterModel=env.withContext({...(user.lang?{lang:user.lang}:{}),...(user.tz?{tz:user.tz}:{}),uid:env.uid}).model('ir.filters');
  const embedded=options['embedded_action_id']||false;
  const domain=and([
    cond('action_id','in',[options['action_id']||false,false]),cond('embedded_action_id','=',embedded),
    cond('embedded_parent_res_id','=',embedded&&options['embedded_parent_res_id']||false),
    cond('model_id','=',model),cond('user_ids','in',[env.uid,false]),
  ]);
  return filterModel.read(await filterModel.search(domain),['name','is_default','domain','context','user_ids','sort','embedded_action_id','embedded_parent_res_id']);
}

export async function getViews(env:Environment,model:string,views:readonly (readonly [number|false,string])[],options:Options={}):Promise<{views:Record<string,View>;models:Record<string,RecordValues>}> {
  await env.model(model).checkAccess([],'read');
  const result:{views:Record<string,View>;models:Record<string,RecordValues>}={views:{},models:{}};
  const fields=new Map<string,Set<string>>();
  // the views are looked up and combined together (their reads share round trips, src/db.ts pipelining), then
  // postprocessed one by one in the request's order; a failure is raised in that order too
  const settled=await Promise.allSettled(views.map(([id,type])=>loadView(env,model,type,id||undefined)));
  for(const [i,[,type]] of views.entries()) {
    const done=settled[i]!;
    if(done.status==='rejected') throw done.reason;
    const loaded=done.value;
    const models=await postprocess(env,loaded.arch,model,async (m,t,i,ctx)=>(await loadView(ctx?env.withContext(ctx):env,m,t,i)).arch,!!options['mobile']);
    if(['kanban','list','form'].includes(type)) for(const [m,fs] of models) {fs.add('id');if(env.reg.model(m).fields.has('write_date')) fs.add('write_date');}
    else if(type==='search') models.set(model,new Set(env.reg.model(model).fields.keys()));
    // Native graph/pivot union() calls do not assign the resulting set (ir_ui_view.py:3257).
    for(const [m,fs] of models) {const target=fields.get(m)??new Set<string>();for(const f of fs) target.add(f);fields.set(m,target);}
    result.views[type]={arch:serializeXml(loaded.arch).replace(/\t/g,''),id:loaded.id,model};
  }
  const attrs=env.reg.model(model).viewFieldAttributes;
  if(!attrs?.length) throw new NotPorted(`view field attributes for ${model}`);
  for(const [m,fs] of fields) result.models[m]={fields:await env.model(m).fieldsGet([...fs],attrs)};
  if(options['toolbar']) {
    for(const view of Object.values(result.views)) view.toolbar={};
    const bound=await bindings(env,model);
    for(const [type,key] of [['report','print'],['action','action']]) for(const action of bound[type!]??[]) {
      const types=typeof action['binding_view_types']==='string' && action['binding_view_types'] ? action['binding_view_types'].split(',') : Object.keys(result.views);
      for(const t of types) if(result.views[t]) (result.views[t]!.toolbar![key!]??=[]).push(action);
    }
  }
  if(options['load_filters'] && result.views['search']) result.views['search'].filters=await filters(env,model,options);
  if(result.views['form'] && env.reg.model(model).isMailThread && env.reg.model(model).hasActivities) result.models[model]!['has_activities']=true;
  return result;
}

registerBaseMethod('get_views',async(env,_ids,args,kw,model)=>{
  const views=kw['views']??args[0],options=kw['options']??args[1]??{};
  if(!Array.isArray(views)||!views.every(v=>Array.isArray(v)&&v.length===2&&(v[0]===false||typeof v[0]==='number')&&typeof v[1]==='string')||!options||typeof options!=='object'||Array.isArray(options)) throw new OdooError('builtins.TypeError','invalid get_views arguments');
  return getViews(env,model,views,options as Options);
},{apiModel:true,readonly:true});
