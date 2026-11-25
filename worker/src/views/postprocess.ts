/** ir_ui_view.py:1305-1815, 3402-3705. Postprocessing runs before per-user
 * pruning so fields needed under other group combinations remain in metadata. */
import { NotPorted } from "../errors";
import type { Environment, FieldDef } from "../orm/types";
import { expressionFieldNames } from "../web/fieldnames";
import { hasModelAccess, userGroupIds, userHasGroup } from "../web/groups";
import { addNext, append, childElements, detach, element, getPrevious, iter, type Element } from "../xml/node";
import { Groups, groupDefinitions, modelGroups } from "./groups";

type Reason = { groups:Groups; attr:string; expr:string; node:Element };
type Info = { modelGroups:Groups; viewGroups:Groups; editable:boolean };
export type ViewLoader = (model:string,type:string,id?:number,context?:Readonly<Record<string,unknown>>) => Promise<Element>;
const SUBVIEWS=new Set(['form','list','graph','kanban','calendar']);
const MODIFIERS=new Set(['column_invisible','invisible','readonly','required']);
const pybool=(v:boolean):string=>v?'True':'False';
function repr(s:string):string {
  const quote=s.includes("'") && !s.includes('"') ? '"' : "'";
  return quote+s.replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\t/g,'\\t').split(quote).join('\\'+quote)+quote;
}

class Names {
  readonly available=new Map<string,Groups[]>();
  readonly fieldGroups=new Map<string,Groups>();
  readonly used=new Map<string,Map<string,Reason>>();
  readonly children:Names[]=[];
  constructor(readonly env:Environment,readonly model:string,readonly groups:Groups,readonly parent:Names|null) { parent?.children.push(this); }
  has(name:string,info:Info):void {
    const list=this.available.get(name)??[]; list.push(info.viewGroups); this.available.set(name,list); this.fieldGroups.set(name,info.modelGroups);
  }
  must(node:Element,names:Iterable<string>,info:Info,attr:string,expr:string):void {
    const groups=info.modelGroups.and(info.viewGroups);
    for(const name of names) {
      if(name==='id') continue;
      if(name.startsWith('parent.')) {this.parent?.must(node,[name.slice(7)],info,attr,expr);continue;}
      const uses=this.used.get(name)??new Map<string,Reason>();
      uses.set(groups.key,{groups,attr,expr,node});this.used.set(name,uses);
    }
  }
  async missing(root:Element,restrictions:Map<Element,Groups>):Promise<void> {
    const defs=await groupDefinitions(this.env), model=this.env.reg.model(this.model);
    for(const [name,reasons] of this.used) {
      const field=model.fields.get(name);
      if(!field || !Object.hasOwn(await this.env.model(this.model).fieldsGet([name],[]),name)) continue;
      const access=this.fieldGroups.get(name)??(field.groups?.length ? this.groups.and(defs.parse(field.groups.join(','))) : this.groups);
      const available=(this.available.get(name)??[]).reduce((a,b)=>a.or(b),defs.empty);
      const errors:Reason[]=[], used:Reason[]=[];
      for(const reason of reasons.values()) {
        if(reason.groups.empty) {if(!this.available.has(name)) used.push(reason);}
        else if(!reason.groups.le(access)) errors.push(reason);
        else if(!reason.groups.le(available)) used.push(reason);
      }
      const selected=errors.length?errors:used;
      if(!selected.length) continue;
      const groups=selected.reduce((a,r)=>a.or(r.groups),defs.empty);
      this.available.set(name,[...(this.available.get(name)??[]),groups]);
      let readonly='True';
      const filename=selected.filter(r=>r.attr==='filename').at(-1);
      if(filename) {
        const binary=model.fields.get(filename.node.attrib.get('name')??'');
        readonly=filename.node.attrib.get('readonly') || pybool(binary?.type==='binary' ? binary.readonly : true);
      }
      const node=element('field',[
        ['name',name],[root.tag==='list'?'column_invisible':'invisible','True'],['readonly',readonly],
        ['data-used-by',selected.map(r=>`${r.attr}=${repr(r.expr)} (${r.node.tag},${r.node.attrib.get('name')??'None'})`).join('; ')],
      ]);
      if(!errors.length) {
        const subset=groups.invertIntersect(this.groups)??groups;
        if(!subset.universal) restrictions.set(node,subset);
      }
      node.tail='\n';append(root,node);
    }
  }
  collect(out:Map<string,Set<string>>):void {
    const fields=out.get(this.model)??new Set<string>();
    for(const name of this.available.keys()) fields.add(name);
    out.set(this.model,fields);for(const child of this.children) child.collect(out);
  }
}

export async function postprocess(env:Environment,root:Element,model:string,load:ViewLoader,mobile=false):Promise<Map<string,Set<string>>> {
  const defs=await groupDefinitions(env);
  const viewTypes=new Set(env.reg.model('ir.ui.view').fields.get('type')?.selection?.map(s=>s.value));
  const restrictions=new Map<Element,Groups>();
  async function process(root:Element,model:string,editable:boolean,parent:Names|null,outer?:Info):Promise<Names> {
    const modelDef=env.reg.model(model);
    const access=(outer?.modelGroups??defs.universe).and(await modelGroups(env,model));
    const names=new Names(env,model,access,parent);
    const viewGroups=outer?.viewGroups??defs.universe;
    // _postprocess_debug_to_cache precedes traversal and modifier collection.
    for(const node of iter(root)) {
      const spec=node.attrib.get('groups');
      if(spec?.includes('base.group_no_one')) {
        const groups=spec.split(',');node.attrib.set('__debug__',pybool(groups.includes('base.group_no_one')));
        node.attrib.set('groups',groups.filter(g=>!g.endsWith('base.group_no_one')).join(','));
      }
    }
    const stack:{node:Element;info:Info}[]=[{node:root,info:{modelGroups:access,viewGroups,editable}}];
    while(stack.length) {
      const {node,info:inherited}=stack.pop()!;
      const name=node.attrib.get('name')??'';
      const field=modelDef.fields.get(name);
      const info:Info={...inherited,modelGroups:access};
      info.editable=info.editable && (node.tag==='form' || (node.tag==='list' ? !!(node.attrib.get('editable')||node.attrib.get('multi_edit'))
        : node.tag==='field' ? (!field||!field.readonly) && !['1','True'].includes(node.attrib.get('readonly')??'') : !viewTypes.has(node.tag)));
      const groupSpec=node.attrib.get('groups');
      if(groupSpec) info.viewGroups=info.viewGroups.and(defs.parse(groupSpec));
      let children=childElements(node);
      const fieldAccess=(f:FieldDef|undefined):void=>{if(f?.groups?.length) info.modelGroups=info.modelGroups.and(defs.parse(f.groups.join(',')));};
      const requireExpression=(attr:string,expr:string|undefined):void=>{if(expr) names.must(node,expressionFieldNames(expr),info,attr,expr);};
      if(node.tag==='field' && name) {
        if(field) {
          fieldAccess(field);
          if(root.tag==='form' && ['one2many','many2many'].includes(field.type) && !node.attrib.get('widget') && !['1','True'].includes(node.attrib.get('invisible')??'') && !parent) {
            const current=children.filter(c=>[...iter(c,'field')].length).map(c=>c.tag);
            if(!(node.attrib.get('mode')??'kanban,list').split(',').some(t=>current.includes(t))) {
              const type=(node.attrib.get('mode')??(mobile?'kanban':'list')).split(',')[0]!;
              const context:Record<string,unknown>={...env.context,[`${type}_view_ref`]:null};
              for(const match of (node.attrib.get('context')??'').matchAll(/['"](\w+_view_ref)['"]\s*:\s*['"]([^'"]+)['"]/g)) context[match[1]!]=match[2];
              append(node,await load(field.relation!,type,undefined,context)); children=childElements(node);
            }
          }
          if(field.relation) {
            let domain=node.attrib.get('domain');
            if(!domain && info.editable) {
              // ir_ui_view.py:1699 `field._description_domain(self.env)`: the field's domain whether or not the user may
              // read the field (fields_get leaves out a field of groups the user lacks; the node itself is removed
              // later, and the fields its domain uses are still added for the other users)
              const attrs=(await env.model(model).fieldsGet([name],['domain']))[name]
                ?? (await env.sudo().model(model).fieldsGet([name],['domain']))[name];
              if(typeof attrs?.['domain']==='string') domain=attrs['domain'];
            }
            requireExpression('domain',domain);
          }
          if(field.type==='properties' && field.definitionRecord) names.must(node,[field.definitionRecord],info,'fieldname',name);
          requireExpression('context',node.attrib.get('context'));
          if(field.type==='binary' && node.attrib.get('filename')) names.must(node,[node.attrib.get('filename')!],info,'filename',node.attrib.get('filename')!);
          for(const child of children) if(SUBVIEWS.has(child.tag)) {
            if(!field.relation) throw new NotPorted(`subview of nonrelational ${model}.${name}`);
            await process(child,field.relation,info.editable,names,info);children=[];
          }
          if(info.editable && ['many2one','many2many'].includes(field.type)) node.attrib.set('model_access_rights',field.relation!);
        }
        names.has(name,info);
      } else if(node.tag==='label') fieldAccess(modelDef.fields.get(node.attrib.get('for')??''));
      else if(node.tag==='filter') {fieldAccess(modelDef.fields.get(node.attrib.get('date')??''));fieldAccess(modelDef.fields.get(node.attrib.get('end_date')??''));}
      else if(node.tag==='card' && root.tag!=='card') {await process(node,model,false,names,info);children=[];}
      else if(node.tag==='groupby' && field?.relation) {await process(node,field.relation,false,names,info);names.has(name,info);children=[];}
      else if(node.tag==='kanban' && node.attrib.get('card_id')) {
        append(node,await load(model,'card',Number(node.attrib.get('card_id'))));children=childElements(node);
      } else if(node.tag==='search') {
        const panel=children.find(c=>c.tag==='searchpanel');
        if(panel) {await process(panel,model,false,names,info);children=children.filter(c=>c!==panel);}
      } else if(node.tag==='calendar') {
        for(const attr of ['date_start','date_stop','color','all_day','aggregate']) if(node.attrib.get(attr)) names.has(node.attrib.get(attr)!.split(':')[0]!,info);
        for(const child of children) if(child.tag==='filter') names.has(child.attrib.get('name')!,info);
      }
      for(const child of [...children].reverse()) stack.push({node:child,info:{...info}});
      if(groupSpec || access.key!==info.modelGroups.key) restrictions.set(node,info.modelGroups.and(info.viewGroups));
      for(const [attr,expr] of node.attrib) if(MODIFIERS.has(attr)||attr.startsWith('decoration-')) requireExpression(attr,expr);
      node.attrib.delete('groups');
    }
    await names.missing(root,restrictions);
    root.attrib.set('model_access_rights',model);
    if(['form','list','kanban'].includes(root.tag)) {
      const nodes=new Map<string,Element[]>();
      const collect=(node:Element,model:string):void=>{
        if(node.tag==='field') {
          const f=env.reg.model(model).fields.get(node.attrib.get('name')??'');
          if(f) {const key=`${model}.${f.name}`,list=nodes.get(key)??[];list.push(node);nodes.set(key,list);if(f.relation) model=f.relation;}
        }
        for(const child of childElements(node)) collect(child,model);
      };collect(root,model);
      for(const [key,elements] of nodes) {
        const dot=key.lastIndexOf('.'),field=env.reg.model(key.slice(0,dot)).fields.get(key.slice(dot+1))!;
        if(field.onchange || field.onchangeDependents?.some(d=>nodes.has(d))) for(const node of elements) if(!node.attrib.get('on_change')) node.attrib.set('on_change','1');
      }
    }
    return names;
  }
  const names=await process(root,model,true,null);
  const models=new Map<string,Set<string>>();names.collect(models);
  const ids=await userGroupIds(env);
  for(const node of [...iter(root)]) {
    const groups=restrictions.get(node);if(!groups) continue;
    if(!groups.matches(ids)) {
      const previous=getPrevious(node),parent=node.parent,tail=node.tail;detach(node);
      if(tail) {if(previous) previous.tail=(previous.tail??'')+tail;else if(parent) parent.text=(parent.text??'')+tail;}
    } else if(node.tag==='t' && !node.attrib.size) {
      for(const child of [...node.children].reverse()) addNext(node,child);detach(node);
    }
  }
  for(const node of iter(root)) {
    const model=node.attrib.get('model_access_rights');if(!model) continue;
    node.attrib.delete('model_access_rights');
    if(node.tag==='field') {
      node.attrib.set('can_create',pybool(await hasModelAccess(env,model,'create')));
      node.attrib.set('can_write',pybool(await hasModelAccess(env,model,'write')));
    } else {
      for(const [attr,op] of [['create','create'],['delete','unlink'],['edit','write']] as const) if(!node.attrib.get(attr) && !await hasModelAccess(env,model,op)) node.attrib.set(attr,'False');
      if(node.tag==='kanban') {
        const field=env.reg.model(model).fields.get(node.attrib.get('default_group_by')??'');
        if(field?.type==='many2one') for(const [attr,op] of [['group_create','create'],['group_delete','unlink'],['group_edit','write']] as const) if(!node.attrib.get(attr) && !await hasModelAccess(env,field.relation!,op)) node.attrib.set(attr,'False');
      }
    }
  }
  const debug=await userHasGroup(env,'base.group_no_one');
  for(const node of iter(root)) if(node.attrib.has('__debug__')) {
    const enabled=node.attrib.get('__debug__')==='True';node.attrib.delete('__debug__');
    if(enabled!==debug) {node.attrib.set('invisible','1');node.attrib.set('column_invisible','1');}
  }
  return models;
}
