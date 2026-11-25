/** Group set expressions, odoo/tools/set_expression.py. DNF with the native
 * implication/disjoint simplifications, used by ir.ui.view.NameManager. */
import type { Domain, Environment } from "../orm/types";
import { parseDomain } from "../orm/domain";
import { evalPyExpr, parsePyExpr } from "../orm/pyexpr";
import { NotPorted } from "../errors";

type Id = number | string;
type Leaf = readonly [Id, boolean]; // id, negative
type Inter = readonly Leaf[];
const STAR: Leaf = ["*", false];
const EMPTY: Leaf = ["*", true];
const negate = ([id, negative]: Leaf): Leaf => [id, !negative];
const compareId = (a: Id, b: Id): number => typeof a === "number" && typeof b === "number" ? a-b
  : typeof a === "number" ? -1 : typeof b === "number" ? 1 : a < b ? -1 : a > b ? 1 : 0;
const same = (a: Leaf, b: Leaf): boolean => a[0] === b[0] && a[1] === b[1];

export class GroupDefinitions {
  readonly supersets = new Map<Id, Set<Id>>();
  readonly disjoints = new Map<Id, Set<Id>>();
  readonly refs = new Map<string, Id>();
  constructor(ids: readonly number[], implications: readonly (readonly [number, number])[], disjointIds: readonly number[], refs: readonly (readonly [string, number])[]) {
    for (const id of ids) this.supersets.set(id, new Set([id]));
    for (const [ref,id] of refs) this.refs.set(ref,id);
    for (const [id,parent] of implications) this.supersets.get(id)?.add(parent);
    let changed = true;
    while (changed) {
      changed = false;
      for (const supers of this.supersets.values()) for (const id of supers) for (const parent of this.supersets.get(id) ?? []) {
        if (!supers.has(parent)) { supers.add(parent); changed = true; }
      }
    }
    for (const [id, parents] of this.supersets) {
      const disjoint = new Set<Id>();
      for (const [other, others] of this.supersets) if (disjointIds.some(a => parents.has(a) && disjointIds.some(b => a !== b && others.has(b)))) disjoint.add(other);
      this.disjoints.set(id,disjoint);
    }
  }
  get universe(): Groups { return new Groups(this,[[]]); }
  get empty(): Groups { return new Groups(this,[]); }
  fromIds(ids: readonly number[]): Groups { return new Groups(this,ids.map(id=>[[id,false]])); }
  parse(spec: string): Groups {
    const pos: Leaf[] = [], neg: Leaf[] = [];
    for (const ref of spec.split(",")) {
      const negative = ref.startsWith("!");
      const name = negative ? ref.slice(1) : ref;
      const leaf: Leaf = [name === "*" ? "*" : this.refs.get(name) ?? name, negative];
      (negative ? neg : pos).push(leaf);
    }
    return new Groups(this,pos.length ? pos.map(p=>[p,...neg]) : [neg]);
  }
  le(a: Leaf, b: Leaf): boolean {
    if (same(a,EMPTY) || same(b,STAR)) return true;
    if (same(a,STAR) || same(b,EMPTY)) return false;
    if (a[1]) return b[1] && this.le(negate(b),negate(a));
    if (b[1]) return this.disjoints.get(b[0])?.has(a[0]) ?? false;
    return a[0] === b[0] || (this.supersets.get(a[0])?.has(b[0]) ?? false);
  }
  disjoint(a: Leaf,b: Leaf): boolean {
    if (a[1]) return this.le(b,negate(a));
    if (b[1]) return this.le(a,negate(b));
    return this.disjoints.get(b[0])?.has(a[0]) ?? false;
  }
  inter(leaves: Inter): Inter {
    const result: Leaf[] = [];
    for (const added of leaves) {
      let found = false;
      for (let i=0;i<result.length;i++) {
        const leaf=result[i]!;
        if (this.disjoint(leaf,added)) return [EMPTY];
        if (this.le(leaf,added)) { found=true; break; }
        if (this.le(added,leaf)) { result[i]=added; found=true; break; }
      }
      if (!found && !same(added,STAR)) result.push(added);
    }
    return result.sort((a,b)=>compareId(a[0],b[0]) || Number(a[1])-Number(b[1]));
  }
  interLe(a:Inter,b:Inter):boolean { return b.every(lb=>a.some(la=>this.le(la,lb))); }
  merge(a:Inter,b:Inter):Inter|null {
    if (!a.length || this.interLe(b,a)) return a;
    if (this.interLe(a,b)) return b;
    if (a.length !== b.length) return null;
    let opposite=-1;
    for (let i=0;i<a.length;i++) {
      if (a[i]![0] !== b[i]![0]) return null;
      if (a[i]![1] !== b[i]![1]) { if(opposite>=0) return null; opposite=i; }
    }
    return opposite<0 ? null : a.filter((_,i)=>i!==opposite);
  }
}

export class Groups {
  readonly terms: readonly Inter[];
  readonly key: string;
  constructor(readonly defs: GroupDefinitions, terms: readonly Inter[]) {
    const result: Inter[] = [], todo=terms.map(t=>defs.inter(t));
    while (todo.length) {
      const term=todo.pop()!;
      if (term.some(l=>same(l,EMPTY))) continue;
      if (!term.length) { result.splice(0,result.length,[]); break; }
      const index=result.findIndex(other=>defs.merge(other,term)!==null);
      if(index>=0) { const merged=defs.merge(result[index]!,term)!; result.splice(index,1); todo.push(merged); }
      else result.push(term);
    }
    this.terms=result.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    this.key=JSON.stringify(this.terms);
  }
  get empty():boolean { return this.terms.length===0; }
  get universal():boolean { return this.terms.some(t=>t.length===0); }
  and(other:Groups):Groups { return new Groups(this.defs,this.terms.flatMap(a=>other.terms.map(b=>[...a,...b]))); }
  or(other:Groups):Groups { return new Groups(this.defs,[...this.terms,...other.terms]); }
  not():Groups { return this.terms.reduce((out,t)=>out.and(new Groups(this.defs,t.map(l=>[negate(l)]))),this.defs.universe); }
  le(other:Groups):boolean {
    if (this.key===other.key) return true;
    if (this.universal || other.empty) return false;
    if (other.universal || this.empty) return true;
    return this.terms.every(a=>other.terms.some(b=>this.defs.interLe(a,b)));
  }
  matches(ids:ReadonlySet<number>):boolean {
    if(this.empty || !ids.size) return false;
    if(this.universal) return true;
    return this.terms.some(t=>t.every(([id,negative])=>negative !== (typeof id==='number' && ids.has(id))));
  }
  invertIntersect(factor:Groups):Groups|null {
    if(this.key===factor.key) return this.defs.universe;
    const rf=factor.not(), rs=this.not();
    if(rf.empty || rf.universal) return null;
    const keys=new Set(rf.terms.map(t=>JSON.stringify(t)));
    const remaining=rs.terms.filter(t=>!keys.has(JSON.stringify(t)));
    return rs.terms.length-remaining.length===rf.terms.length ? new Groups(this.defs,remaining).not() : null;
  }
}

export async function groupDefinitions(env:Environment):Promise<GroupDefinitions> {
  const key='view.group_definitions';
  const cached=env.cache.get(key);
  if(cached instanceof GroupDefinitions) return cached;
  const ids=(await env.cr.query<{id:number}>('SELECT id FROM res_groups')).rows.map(r=>r.id);
  const implied=(await env.cr.query<{gid:number;hid:number}>('SELECT gid,hid FROM res_groups_implied_rel')).rows.map(r=>[r.gid,r.hid] as const);
  const refs=(await env.cr.query<{ref:string;res_id:number}>("SELECT module||'.'||name AS ref,res_id FROM ir_model_data WHERE model='res.groups' ORDER BY id")).rows.map(r=>[r.ref,r.res_id] as const);
  const disjoint=refs.filter(([r])=>['base.group_user','base.group_portal','base.group_public'].includes(r)).map(([,id])=>id);
  const defs=new GroupDefinitions(ids,implied,disjoint,refs); env.cache.set(key,defs); return defs;
}

/** ir_access.py:349 _get_groups_with_access. Access-domain operators need a
 * recursive model-group calculation; refuse those until it is ported. */
export async function modelGroups(env:Environment, model:string, operation='read', depth=0):Promise<Groups> {
  const key=`view.access_groups:${model}:${operation}`;
  const cached=env.cache.get(key); if(cached instanceof Groups) return cached;
  if(depth>8) throw new NotPorted(`recursive access conditions for ${model}`);
  const letter={read:'r',write:'u',create:'c',unlink:'d'}[operation];
  if(letter===undefined) throw new NotPorted(`access operation ${operation}`);
  const defs=await groupDefinitions(env);
  const rows=(await env.cr.query<{group_id:number;domain:string|null}>(
    `SELECT a.group_id,a.domain FROM ir_access a JOIN ir_model m ON m.id=a.model_id
     WHERE a.active AND a.group_id IS NOT NULL AND a.operation LIKE $2 AND m.model=$1`,[model,`%${letter}%`])).rows;
  let groups=defs.empty;
  for(const r of rows) {
    const own=defs.fromIds([r.group_id]);
    if(!r.domain || !/['"]access['"]/.test(r.domain)) { groups=groups.or(own); continue; }
    // ir_access.py:349-399: only the 'access' conditions of the domain matter; each is the groups with that access
    // on the comodel, combined with the domain's logic and intersected with the access's own groups
    const parsed=parseDomain(evalPyExpr(parsePyExpr(r.domain),()=>0));
    const satisfying=async(d:Domain):Promise<Groups>=>{
      switch(d.kind){
        case 'true': return defs.universe;
        case 'false': return defs.empty;
        case 'cond': {
          if(d.op!=='access') return defs.universe;
          const f=env.reg.model(model).fields.get(d.path);
          if(!f?.relation || typeof d.value!=='string') throw new NotPorted(`access condition ${d.path} on ${model}`);
          return modelGroups(env,f.relation,d.value,depth+1);
        }
        case 'and': { let g=defs.universe; for(const c of d.args) g=g.and(await satisfying(c)); return g; }
        case 'or': { let g=defs.empty; for(const c of d.args) g=g.or(await satisfying(c)); return g; }
        case 'not': return (await satisfying(d.arg)).not();
      }
    };
    groups=groups.or(own.and(await satisfying(parsed)));
  }
  for(const parent of env.reg.model(model).inherits.keys()) groups=groups.and(await modelGroups(env,parent));
  env.cache.set(key,groups); return groups;
}
