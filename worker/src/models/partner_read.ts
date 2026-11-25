/** Contacts read-side computes: base/models/res_partner.py:407,
 * properties_base_definition_mixin.py:25, mail_activity_mixin.py:146-230. */
import { NotPorted } from '../errors';
import { envCache, userInfo } from '../orm/env';
import { registerHooks } from '../orm/hooks';
import type { Environment } from '../orm/types';
import { dbNow, todayInTz, translate, validTz } from './util';

interface Activity {id:number;res_id:number;date_deadline:string|null;active:boolean;user_id:number;user_tz:string|null;decoration_type:string|null;icon:string|null}
function activities(env:Environment,ids:readonly number[]):Promise<Activity[]> {
  const active=env.context['active_test']!==false;
  return envCache(env,`partner.activities:${JSON.stringify([ids,active])}`,async()=>
    (await env.cr.query<Activity>(`SELECT a.id,a.res_id,a.date_deadline::text,a.active,a.user_id,a.user_tz,t.decoration_type,t.icon
     FROM mail_activity a LEFT JOIN mail_activity_type t ON t.id=a.activity_type_id
     WHERE a.res_model='res.partner' AND a.res_id=ANY($1::int[]) AND ($2=false OR a.active)
     ORDER BY a.date_deadline,a.id`,[ids,active])).rows);
}

registerHooks('res.partner',{computed:{
  // application_statistics: src/models/partner_erp.ts (base and the account, crm, purchase and sale hooks). Its own
  // entry here, registered after partner_erp's once controllers/portal_address imported partner_erp first (2c769259),
  // refused the Contacts list with crm installed (gate C3)
  properties_base_definition_id:async(env,ids)=>{
    const row=(await env.cr.query<{id:number}>(`SELECT d.id FROM properties_base_definition d JOIN ir_model_fields f ON f.id=d.properties_field_id
      WHERE f.model='res.partner' AND f.name='properties' ORDER BY d.id LIMIT 1`)).rows[0];
    if(!row) throw new NotPorted('create missing properties.base.definition');
    return new Map(ids.map(id=>[id,row.id]));
  },
  activity_state:async(env,ids)=>{
    const rows=await activities(env,ids),now=await dbNow(env),user=await userInfo(env);
    const result=new Map<number,unknown>(ids.map(id=>[id,false]));
    for(const a of rows) {
      if(!a.date_deadline||!a.active) continue;
      const today=todayInTz(now,validTz(a.user_tz||env.context.tz||user.tz)||'UTC');
      const state=a.date_deadline<today?'overdue':a.date_deadline===today?'today':'planned';
      const previous=result.get(a.res_id);
      if(previous!=='overdue'&&(previous!=='today'||state==='overdue')) result.set(a.res_id,state);
    }
    return result;
  },
  activity_exception_decoration:async(env,ids)=>exception(env,ids,'decoration_type'),
  activity_exception_icon:async(env,ids)=>exception(env,ids,'icon'),
  activity_user_id:async(env,ids)=>{
    const rows=await activities(env,ids);return new Map(ids.map(id=>[id,rows.find(r=>r.res_id===id)?.user_id??false]));
  },
  activity_date_deadline:async(env,ids)=>{
    const rows=await activities(env,ids);return new Map(ids.map(id=>[id,rows.find(r=>r.res_id===id)?.date_deadline??false]));
  },
  my_activity_date_deadline:async(env,ids)=>{
    const rows=await activities(env,ids);return new Map(ids.map(id=>[id,rows.find(r=>r.res_id===id&&r.user_id===env.uid)?.date_deadline??false]));
  },
}});

async function exception(env:Environment,ids:readonly number[],field:'decoration_type'|'icon'):Promise<Map<number,unknown>> {
  const rows=await activities(env,ids),selected=new Map<number,Activity>();
  for(const row of rows) if(selected.get(row.res_id)?.decoration_type!=='danger' && ['danger','warning'].includes(row.decoration_type??'')) selected.set(row.res_id,row);
  return new Map(ids.map(id=>[id,selected.get(id)?.[field]||false]));
}

registerHooks('properties.base.definition',{displayName:async(env,ids)=>{
  // properties_base_definition.py:23-32: base's `_("%s Properties", <model>._description)`; `_description` is the
  // class attribute, untranslated (ir_model.name's en_US value is set from it, model_classes.py:285-296)
  // fr_FR keeps the round-1 port (base/i18n/fr.po "%s Properties", measured on poc_corpus, which has no _() tables)
  const fr=env.lang==='fr_FR';
  const rows=(await env.cr.query<{id:number;name:string}>(`SELECT d.id,${fr?"COALESCE(m.name->>'fr_FR',m.name->>'en_US')":"m.name->>'en_US'"} AS name
    FROM properties_base_definition d JOIN ir_model_fields f ON f.id=d.properties_field_id
    JOIN ir_model m ON m.model=f.model WHERE d.id=ANY($1::int[])`,[ids])).rows;
  const pattern=fr?'%s Propriétés':translate(env,'%s Properties','base');
  return new Map(rows.map(r=>[r.id,pattern.replace('%s',r.name)]));
}});

// res_country.py:293, state display names include the country code.
registerHooks('res.country.state',{displayName:async(env,ids)=>{
  const rows=(await env.cr.query<{id:number;name:string;code:string}>(
    'SELECT s.id,s.name,c.code FROM res_country_state s JOIN res_country c ON c.id=s.country_id WHERE s.id=ANY($1::int[])',[ids])).rows;
  return new Map(rows.map(r=>[r.id,env.context['formatted_display_name']?`${r.name} \t --${r.code}--`:`${r.name} (${r.code})`]));
}});

// res_partner.py:245 walks every category parent, including archived parents.
registerHooks('res.partner.category',{displayName:async(env,ids)=>{
  const rows=(await env.cr.query<{root:number;name:string}>(`WITH RECURSIVE names AS (
    SELECT id AS root,id,parent_id,COALESCE(name->>$2,name->>'en_US','') AS name FROM res_partner_category WHERE id=ANY($1::int[])
    UNION ALL SELECT n.root,p.id,p.parent_id,COALESCE(p.name->>$2,p.name->>'en_US','')||' / '||n.name
    FROM names n JOIN res_partner_category p ON p.id=n.parent_id)
    SELECT root,name FROM names WHERE parent_id IS NULL`,[ids,env.lang??'en_US'])).rows;
  return new Map(rows.map(r=>[r.root,r.name]));
}});
