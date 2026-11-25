/** mail/controllers/webclient.py failures/systray_get_activities and
 * mail/models/res_users.py _divide_activities_in_groups/_format_activity_group. */
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { cond } from '../orm/domain';
import { userInfo } from '../orm/env';
import { icpInt } from '../session/user';
import { hasModelAccess } from '../web/groups';
import { dbNow, todayInTz, translate } from '../models/util';
import { Store } from './store';
import { applyActivityGroupOverrides } from './activity_group_overrides';
import { inOrder } from '../in_order';

export async function failures(env:Environment,store:Store):Promise<void> {
  const self=await userInfo(env);
  // Native sudo search deliberately restricts author, then existence of the target.
  const rows=(await env.cr.query<{id:number;mail_message_id:number;model:string;res_id:number}>(`SELECT n.id,n.mail_message_id,m.model,m.res_id FROM mail_notification n
    JOIN mail_message m ON m.id=n.mail_message_id WHERE m.author_id=$1 AND n.notification_status IN ('bounce','exception')
    AND m.message_type!='user_notification' AND m.model IS NOT NULL AND m.res_id!=0 ORDER BY n.id LIMIT 100`,[self.partnerId])).rows;
  // webclient.py:121-136: the messages of the notifications, read together (`notifications.mail_message_id`)
  const refs=[...new Set(rows.map(r=>r.mail_message_id))].map((mid)=>{
    const ref=rows.find(r=>r.mail_message_id===mid)!;
    return {mid,model:ref.model,res_id:ref.res_id};
  });
  for(const d of await notificationMessagesData(env,refs))addNotificationData(store,d);
}

interface NotificationRow {id:number;mail_message_id:number;res_partner_id:number|null;mail_email_address:string|null;notification_status:string;notification_type:string;failure_type:string|null;name:string|null;email:string|null}
interface NotificationData {mid:number;ref:{model:string;res_id:number};message:Record<string,unknown>;notifications:NotificationRow[];partnerNames:Map<number,unknown>;modelName:string|undefined;threadName:unknown}

/**
 * The reads of `_store_notification_fields` for messages (`addNotificationData` fills the store with them), for all of
 * them at once as Odoo's recordset reads them (webclient.py:121-136, mail_message.py:1430-1443): the threads' existence
 * and names per model, the messages, their notifications and the partners named by them, each one statement.
 */
async function notificationMessagesData(env:Environment,refs:readonly {mid:number;model:string;res_id:number}[]):Promise<NotificationData[]> {
  if(!refs.length)return [];
  const byModel=new Map<string,number[]>();
  for(const r of refs){const ids=byModel.get(r.model)??[];if(!ids.includes(r.res_id))ids.push(r.res_id);byModel.set(r.model,ids);}
  const models=[...byModel.keys()];
  const sudo=(name:string)=>env.sudo().withContext({...env.context,active_test:false}).model(name);
  // webclient.py:124-127 `browse(ids).exists()` per model
  const existing=await inOrder(models.map((name)=>sudo(name).search(cond('id','in',byModel.get(name)!))));
  models.forEach((name,i)=>{
    const found=new Set(existing[i]!);
    if(byModel.get(name)!.some(id=>!found.has(id)))throw new NotPorted('mail failures cleanup of orphan notifications');
  });
  const mids=refs.map(r=>r.mid);
  const [messages,notifications,modelRows,threadNames]=await inOrder([
    env.sudo().model('mail.message').read(mids,['author_id','author_guest_id','body','date','message_type'],'web'),
    // mail_notification.py:121-131 `_filtered_for_web_client` of `message.notification_ids`
    env.cr.query<NotificationRow>(`SELECT n.id,n.mail_message_id,n.res_partner_id,n.mail_email_address,n.notification_status,n.notification_type,n.failure_type,p.name,p.email
      FROM mail_notification n JOIN mail_message m ON m.id=n.mail_message_id LEFT JOIN res_partner p ON p.id=n.res_partner_id
      LEFT JOIN mail_message_subtype s ON s.id=m.subtype_id WHERE n.mail_message_id=ANY($1::int[])
      AND (n.notification_status IN ('bounce','exception','canceled') OR p.partner_share OR (n.res_partner_id IS NULL AND n.mail_email_address IS NOT NULL)
      OR m.subtype_id IS NULL OR s.track_recipients) ORDER BY n.id`,[mids]).then((r)=>r.rows),
    env.cr.query<{model:string;name:string}>("SELECT model,COALESCE(name->>$2,name->>'en_US') AS name FROM ir_model WHERE model=ANY($1::text[])",[models,env.lang||'en_US']).then((r)=>r.rows),
    inOrder(models.map((name)=>sudo(name).displayName(byModel.get(name)!))),
  ] as const);
  const unnamed=[...new Set(notifications.filter(n=>n.res_partner_id&&!n.name).map(n=>n.res_partner_id!))];
  const partnerNames=unnamed.length?await env.sudo().model('res.partner').displayName(unnamed):new Map<number,unknown>();
  const messageOf=new Map(messages.map(m=>[Number(m['id']),m]));
  const modelName=new Map(modelRows.map(r=>[r.model,r.name]));
  return refs.map(({mid,model,res_id})=>{
    const own=notifications.filter(n=>n.mail_message_id===mid);
    const names=new Map<number,unknown>(own.filter(n=>n.res_partner_id&&!n.name).map(n=>[n.res_partner_id!,partnerNames.get(n.res_partner_id!)]));
    return {mid,ref:{model,res_id},message:messageOf.get(mid)!,notifications:own,partnerNames:names,modelName:modelName.get(model),threadName:threadNames[models.indexOf(model)]!.get(res_id)};
  });
}

/** mail_message.py:1430 `_store_notification_fields` of one thread message (the failures payload shape). */
function addNotificationData(store:Store,d:NotificationData):void {
  const {mid,ref,message,notifications}=d;
  store.add('mail.message',mid,{...message,body:message['body']?['markup',message['body']]:false,notification_ids:notifications.map(n=>n.id),thread:{id:ref.res_id,model:ref.model}});
  for(const n of notifications) {
    store.add('mail.notification',n.id,{failure_type:n.failure_type??false,mail_message_id:mid,notification_status:n.notification_status,notification_type:n.notification_type,res_partner_id:n.res_partner_id??false,mail_email_address:n.mail_email_address??false});
    if(n.res_partner_id)store.add('res.partner',n.res_partner_id,{name:n.name||false,email:n.email||false,...(!n.name?{display_name:d.partnerNames.get(n.res_partner_id)}:{})});
  }
  store.add('mail.thread',`${ref.model}:${ref.res_id}`,{id:ref.res_id,model:ref.model,modelName:d.modelName,display_name:d.threadName});
}

/** `_store_notification_fields` of one message: its reads, then the store. */
export async function addNotificationMessage(env:Environment,store:Store,mid:number,refModel:string,refResId:number):Promise<void> {
  addNotificationData(store,(await notificationMessagesData(env,[{mid,model:refModel,res_id:refResId}]))[0]!);
}

export interface Activity {id:number;res_model:string|null;res_id:number|null;date_deadline:string;user_tz:string|null}
export async function activityGroups(env:Environment,store:Store):Promise<void> {
  const self=await userInfo(env),limit=(await icpInt(env.cr,'mail.activity.systray.limit'))||1000;
  // calendar, contacts and project_todo overrides are ported below (activity_group_overrides.ts)
  if(env.reg.model('res.users').modules?.some(m=>['mass_mailing','mass_mailing_sms'].includes(m)))throw new NotPorted('installed activity group override');
  // mail.activity._search explicitly bypasses its extra rules for user_id=env.uid.
  const activities=(await env.cr.query<Activity>('SELECT id,res_model,res_id,date_deadline::text,user_tz FROM mail_activity WHERE user_id=$1 AND active ORDER BY id DESC LIMIT $2',[env.uid,limit])).rows;
  const byModel=new Map<string,Map<number,Activity[]>>();
  for(const a of activities){const name=a.res_model||'mail.activity',id=a.res_model?a.res_id!:a.id;let records=byModel.get(name);if(!records)byModel.set(name,records=new Map());records.set(id,[...(records.get(id)||[]),a]);}
  const grouped=new Map<string,Activity[]>();
  // The models' reads are independent: sent together (they share round trips), used in the models' order below
  const visible=await inOrder([...byModel].map(async([name,records])=>{
    const ids=[...records.keys()];
    const context={...env.context,active_test:false};
    const [access,existingIds]=await inOrder([hasModelAccess(env,name,'read'),env.sudo().withContext(context).model(name).search(cond('id','in',ids))] as const);
    const existing=new Set(existingIds);
    // For personal activities the assigned user always has read access.
    const allowed=new Set(name==='mail.activity'?ids:access?await env.withContext(context).model(name).search(cond('id','in',ids)):[]);
    const allCompanies=new Set(name==='mail.activity'?ids:access?await env.withContext({...context,allowed_company_ids:self.companyIds}).model(name).search(cond('id','in',ids.filter(id=>existing.has(id)&&!allowed.has(id)))):[]);
    return {allowed,allCompanies};
  }));
  let k=0;
  for(const [name,records] of byModel){
    const {allowed,allCompanies}=visible[k++]!;
    for(const [id,list] of records){
      const urgent=[...list].sort((a,b)=>a.date_deadline.localeCompare(b.date_deadline)||a.id-b.id)[0]!;
      const target=allowed.has(id)?name:allCompanies.has(id)?null:'mail.activity';
      if(target)grouped.set(target,[...(grouped.get(target)||[]),urgent]);
    }
  }
  const now=await dbNow(env);
  let groups:Record<string,unknown>[]=[];
  // mail/models/res_users.py:565-586 _format_activity_group
  const format=async(name:string,list:Activity[]):Promise<Record<string,unknown>>=>{
    const model=(await env.cr.query<{id:number;name:string}>("SELECT id,COALESCE(name->>$2,name->>'en_US') name FROM ir_model WHERE model=$1",[name,env.lang||'en_US'])).rows[0]!;
    let overdue=0,today=0,planned=0;
    for(const a of list){const day=todayInTz(now,a.user_tz||String(env.context['tz']||self.tz||'UTC'));if(a.date_deadline<day)overdue++;else if(a.date_deadline===day)today++;else planned++;}
    const def=env.reg.model(name);
    // mail/i18n/fr.po leaves "Other Activities" untranslated.
    const other=env.lang==='fr_FR'?'Other Activities':translate(env,'Other Activities');
    return {id:model.id,name:name==='mail.activity'?other:model.name,model:name,type:'activity',icon:def.moduleIcon??'/base/static/description/icon.png',
      domain:name!=='mail.activity'&&def.fields.has('active')?[['active','in',[true,false]]]:[],total_count:overdue+today,today_count:today,overdue_count:overdue,planned_count:planned,view_type:def.systrayView??'list',activity_ids:list.map(a=>a.id)};
  };
  groups.push(...await inOrder([...grouped].map(([name,list])=>format(name,list))));
  groups=await applyActivityGroupOverrides(env,groups,grouped,format);
  const roleRow=(await env.withContext({...env.context,active_test:false}).model('res.users').read([env.uid],['role_ids'],'web'))[0]!;
  const unassigned=(await env.cr.query<{n:string}>('SELECT count(*)::text n FROM mail_activity WHERE user_id IS NULL AND role_id=ANY($1::int[]) AND active',[roleRow['role_ids']])).rows[0];
  const bus=(await env.cr.query<{id:number|null}>('SELECT max(id) id FROM bus_bus')).rows[0]?.id??0;
  store.global({activities_to_assign_count:Number(unassigned?.n??0),activityCounter:groups.reduce((n,g)=>n+Number(g['total_count']??0),0),activity_counter_bus_id:bus,activity_groups:groups});
}
