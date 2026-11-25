/** Contacts chatter: mail_thread.py _store_thread_fields, mail_message.py
 * _message_fetch/_store_message_fields, and mail/models/models.py recipients.
 * Unsupported rich message kinds refuse before emitting partial Store data. */
import { ratingMessageFields, ratingThreadFields } from './rating';
import { addPollFields } from './poll_store';
import { calendarEventStore, emailSplitTuples, followerPartnersAsUser, isGenericThread } from './thread_generic';
import { NotPorted } from '../errors';
import type { Environment, RecordValues } from '../orm/types';
import { and, cond, parseDomain, TRUE } from '../orm/domain';
import { userInfo } from '../orm/env';
import { userFlags, xmlidToResId, icpStr } from '../session/user';
import { dbNow, todayInTz, textwrapShorten } from '../models/util';
import { Store } from './store';
import { MailBootstrap } from './bootstrap';
import { attachmentStoreFields, ownershipToken } from './attachment';

// Store `_format_fields`: an Html value (Markup, also an empty one) as ["markup", value]; NULL is False
const markup=(value:unknown):unknown=>typeof value==='string'?['markup',value]:false;
const key=(id:number)=>`res.partner:${id}`;
const thread=(id:number)=>({id,model:'res.partner'});
export async function permission(env:Environment,id:number,operation:'read'|'write'):Promise<boolean>{
  const rule=await env.model('res.partner').accessDomain(operation);
  return (await env.sudo().withContext({...env.context,active_test:false}).model('res.partner').search(and([cond('id','=',id),rule??TRUE]))).length>0;
}
export async function checkThread(env:Environment,model:string,id:number):Promise<boolean>{
  if(model!=='res.partner'||!(await userFlags(env.cr,env.uid)).isInternal)throw new NotPorted('chatter access outside internal partner threads');
  return permission(env,id,'read');
}
async function subject(env:Environment,id:number):Promise<string>{return textwrapShorten((await env.sudo().model('res.partner').displayName([id])).get(id)||'',100,'...');}

export async function fetchMessages(env:Environment,id:number,params:Record<string,unknown>,store:Store,dataId:number|null):Promise<number[]>{
  for(const k of Object.keys(params))if(!['limit','before','after'].includes(k))throw new NotPorted(`message fetch ${k}`);
  const domain:unknown[]=[['model','=','res.partner'],['res_id','=',id],['message_type','!=','user_notification']];
  if(params['before'])domain.push(['id','<',params['before']]);if(params['after'])domain.push(['id','>',params['after']]);
  // An internal user who can read the target can read its messages:
  // mail_message.py _search's model/res_id branch and models.py operation map.
  const ids=await env.sudo().model('mail.message').search(parseDomain(domain),{limit:Number(params['limit']??30),order:params['after']?'id ASC':'id DESC'});
  if(params['after'])ids.sort((a,b)=>b-a);
  if(dataId!==null)store.add('DataResponse',dataId,{_resolve:true,messages:ids},false);
  return ids;
}

export async function threadFields(env:Environment,id:number,requests:string[],store:Store):Promise<void>{
  const self=await userInfo(env),partners=new MailBootstrap(env,store),values:Record<string,unknown>={...thread(id),hasReadAccess:true,hasWriteAccess:await permission(env,id,'write'),canPostOnReadonly:true};
  const activeEnv=env.sudo().withContext({...env.context,active_test:true});
  if(requests.includes('activities')){
    const ids=await activeEnv.model('mail.activity').search(parseDomain([['res_model','=','res.partner'],['res_id','=',id]]));
    values['activities']=ids;await activities(env,ids,store,partners);
  }
  if(requests.includes('attachments')){
    const ids=await env.sudo().model('ir.attachment').search(parseDomain([['res_model','=','res.partner'],['res_id','=',id],['res_field','=',false]]),{order:'id desc'});
    // mail_thread.py:5398 _get_mail_thread_data_attachments: original_id/svg variants are not ported
    if(ids.length&&(await env.cr.query('SELECT 1 FROM ir_attachment WHERE id=ANY($1::int[]) AND (original_id IS NOT NULL OR mimetype=$2 OR id IN (SELECT original_id FROM ir_attachment WHERE original_id IS NOT NULL))',[ids,'image/svg+xml'])).rows.length)throw new NotPorted('chatter attachments with original/svg variants');
    for(const aid of ids)store.add('ir.attachment',aid,await attachmentStoreFields(env,aid));
    Object.assign(values,{attachments:ids,areAttachmentsLoaded:true,isLoadingAttachments:false});
  }
  if(requests.includes('contact_fields'))Object.assign(values,{primary_email_field:'email',partner_fields:[]});
  if(requests.includes('defaultSubject'))values['defaultSubject']=await subject(env,id);
  if(requests.includes('followers')){
    const ids=await env.model('mail.followers').search(parseDomain([['res_model','=','res.partner'],['res_id','=',id]]),{order:'id'});
    const followers=await env.sudo().model('mail.followers').read(ids,['partner_id','name','email','is_active','subtype_ids'],'web');
    const own=followers.find(f=>f['partner_id']===self.partnerId),others=followers.filter(f=>f['partner_id']!==self.partnerId);
    const comment=await xmlidToResId(env.cr,'mail.mt_comment'),recipients=others.filter(f=>f['is_active']&&(f['subtype_ids'] as number[]).includes(comment!));
    Object.assign(values,{followersCount:ids.length,selfFollower:own?.['id']??false,followers:others.slice(0,100).map(f=>f['id']),recipientsCount:recipients.length,recipients:recipients.slice(0,100).map(f=>f['id'])});
    const all=[...(own?[own]:[]),...others.slice(0,100),...recipients.slice(0,100)],seen=new Set<number>();
    for(const f of all){const fid=Number(f['id']);if(seen.has(fid))continue;seen.add(fid);const pid=Number(f['partner_id']);
      store.add('mail.followers',fid,{name:f['name'],email:f['email'],is_active:f['is_active'],partner_id:pid,display_name:(await env.sudo().model('res.partner').displayName([pid])).get(pid),thread:thread(id)});
      await partners.partner(pid,true);
    }
  }
  if(requests.includes('has_pinned_messages'))values['has_pinned_messages']=(await env.sudo().model('mail.message').searchCount(parseDomain([['model','=','res.partner'],['res_id','=',id],['pinned_at','!=',false]])))>0;
  if(requests.includes('scheduledMessages')){
    // An empty sudo candidate set proves the user-filtered set is also empty.
    // Nonempty sets refuse until scheduled-message access/serialization is ported.
    const ids=await env.sudo().model('mail.scheduled.message').search(parseDomain([['model','=','res.partner'],['res_id','=',id]]));
    if(ids.length)throw new NotPorted('scheduled chatter messages');values['scheduledMessages']=[];
  }
  if(requests.includes('display_name'))values['display_name']=(await env.model('res.partner').displayName([id])).get(id);
  if(requests.includes('suggestedRecipients'))values['suggestedRecipients']=await suggested(env,id);
  store.add('mail.thread',key(id),values);
}

async function activities(env:Environment,ids:number[],store:Store,partners:MailBootstrap):Promise<void>{
  const fields=['activity_category','activity_type_id','create_date','create_uid','date_deadline','date_done','icon','note','phone','res_id','res_model','role_id','user_id','attachment_ids','mail_template_ids','summary','user_tz','active'];
  // calendar/models/mail_activity.py:96-99 (when calendar is installed): res_name and calendar_event_id
  if(env.reg.models.has('calendar.event'))fields.push('res_name','calendar_event_id');
  const rows=await env.sudo().model('mail.activity').read(ids,fields,'web'),self=await userInfo(env),now=await dbNow(env);
  for(const a of rows){
    if(a['calendar_event_id'])await calendarEventStore(env,Number(a['calendar_event_id']),store);
    let typeName:unknown=false;
    if(a['activity_type_id']){const type=(await env.sudo().model('mail.activity.type').read([Number(a['activity_type_id'])],['name'],'web'))[0];if(type){typeName=type['name'];store.add('mail.activity.type',Number(type['id']),{name:type['name']});}}
    if(a['create_uid']){const creator=(await env.sudo().model('res.users').read([Number(a['create_uid'])],['partner_id'],'web'))[0];if(creator){store.add('res.users',Number(creator['id']),{partner_id:creator['partner_id']});if(creator['partner_id']){const cp=(await env.sudo().model('res.partner').read([Number(creator['partner_id'])],['name'],'web'))[0];if(cp)store.add('res.partner',Number(cp['id']),{name:cp['name']});}}}
    if(a['user_id']){const user=(await env.sudo().model('res.users').read([Number(a['user_id'])],['partner_id'],'web'))[0];if(user){store.add('res.users',Number(user['id']),{partner_id:user['partner_id']});if(user['partner_id'])await partners.partner(Number(user['partner_id']),true);}}
    if(a['role_id']){const role=(await env.sudo().model('res.role').read([Number(a['role_id'])],['name'],'web'))[0];if(role)store.add('res.role',Number(role['id']),{name:role['name']});}
    for(const [field,model] of [['attachment_ids','ir.attachment'],['mail_template_ids','mail.template']] as const)for(const row of await env.sudo().model(model).read(a[field] as number[],['name'],'web'))store.add(model,Number(row['id']),{name:row['name']});
    const day=todayInTz(now,String(a['user_tz']||env.context['tz']||self.tz||'UTC')),deadline=String(a['date_deadline']);
    const {user_tz:_,active:__,...values}=a;
    const canWrite=a['user_id']===env.uid||await permission(env,Number(a['res_id']),'write');
    store.add('mail.activity',Number(a['id']),{...values,note:markup(a['note']),can_write:canWrite,display_name:a['summary']||typeName,state:!a['active']?'done':deadline<day?'overdue':deadline===day?'today':'planned'});
  }
}

interface Recipient {id:number;name:string|null;email:string|null;email_normalized:string|null;active:boolean;partner_share:boolean}
export interface SuggestedRecipient {
  readonly email: string | false;
  readonly name: string | false;
  readonly partner_id: number | false;
  readonly create_values: Record<string, unknown>;
  readonly recipient_type: 'to' | 'cc';
  readonly display_name?: string | undefined;
}

export async function suggested(env:Environment,id:number):Promise<SuggestedRecipient[]>{
  const self=await userInfo(env),partner=(await env.model('res.partner').read([id],['user_id'],'web'))[0]!;
  const initial:number[]=[];
  if(partner['user_id']){const u=(await env.sudo().model('res.users').read([Number(partner['user_id'])],['partner_id'],'web'))[0]!;if(u['partner_id']!==self.partnerId)initial.push(Number(u['partner_id']));}
  initial.push(id);const candidates=[...initial],cc:number[]=[];
  const comment=await xmlidToResId(env.cr,'mail.mt_comment');
  const last=await env.sudo().model('mail.message').search(parseDomain([['model','=','res.partner'],['res_id','=',id],['message_type','in',['email','comment']],['subtype_id','=',comment]]),{order:'date DESC,id DESC',limit:1});
  if(last.length){
    const m=(await env.sudo().model('mail.message').read(last,['partner_ids','partner_cc_ids','author_id','incoming_email_to','incoming_email_cc','email_from'],'web'))[0]!;
    if(m['incoming_email_to']||m['incoming_email_cc'])throw new NotPorted('suggested recipients from incoming email headers');
    const author=m['author_id']?Number(m['author_id']):null;
    const list=[...m['partner_ids'] as number[],...(author?[author]:[])];
    const active=await env.sudo().withContext({...env.context,active_test:true}).model('res.partner').search(cond('id','in',[...list,...m['partner_cc_ids'] as number[]]));
    candidates.push(...list.filter(pid=>active.includes(pid)));cc.push(...(m['partner_cc_ids'] as number[]).filter(pid=>active.includes(pid)));
    if(m['email_from']){
      const sender=String(m['email_from']).match(/(?:<([^<>]+)>|^([^<>\s]+@[^<>\s]+)$)/),email=(sender?.[1]||sender?.[2]||'').toLowerCase();
      const known=author?(await env.sudo().model('res.partner').read([author],['email_normalized'],'web'))[0]?.['email_normalized']:false;
      if(!email||email!==known)throw new NotPorted('suggested recipient for unlinked email author');
    }
  }
  const followers=await followerPartnersAsUser(env,'res.partner',id); // models.py:466 message_partner_ids as the user
  const ids=[...new Set([...candidates,...cc])],rows=(await env.cr.query<Recipient>('SELECT id,name,email,email_normalized,active,partner_share FROM res_partner WHERE id=ANY($1::int[])',[ids])).rows;
  const bot=await xmlidToResId(env.cr,'base.partner_root'),pub=await xmlidToResId(env.cr,'base.public_partner');
  const botEmail=(await env.cr.query<{email_normalized:string|null}>('SELECT email_normalized FROM res_partner WHERE id=$1',[bot])).rows[0]?.email_normalized;
  const aliasDomains=await env.sudo().model('mail.alias.domain').read(await env.sudo().model('mail.alias.domain').search(TRUE),['name','bounce_email','catchall_email','default_from_email'],'web');
  const aliases=await env.sudo().model('mail.alias').read(await env.sudo().model('mail.alias').search(TRUE),['alias_full_name','alias_name','alias_incoming_local'],'web');
  const domains=(await icpStr(env.cr,'mail.catchall.domain.allowed')||'').split(',').filter(Boolean);if(domains.length)domains.push(...aliasDomains.map(d=>String(d['name'])));
  const banned=(email:string|null)=>email===botEmail||!!email&&(aliasDomains.some(d=>['bounce_email','catchall_email','default_from_email'].some(f=>d[f]===email))||aliases.some(a=>a['alias_incoming_local']?a['alias_name']===email.split('@')[0]&&(!domains.length||domains.includes(email.split('@')[1]!)):a['alias_full_name']===email));
  const result:SuggestedRecipient[]=[];
  for(const pid of ids){const p=rows.find(p=>p.id===pid)!;if((followers.includes(pid)&&!(initial.includes(pid)&&p.partner_share))||banned(p.email_normalized)||pid===pub)continue;
    result.push({email:p.email_normalized||false,name:p.name||false,partner_id:pid,create_values:{},recipient_type:cc.includes(pid)?'cc':'to',...(!p.name?{display_name:(await env.sudo().model('res.partner').displayName([pid])).get(pid)}:{})});
  }return result;
}

/** `currentUser`: the Store has no bus target (the request's answer), so it carries the user's own fields
 *  (tools/discuss.py:896-907 `is_for_current_user`: the polls' `selected_by_self`); `inbox`: the thread's inbox fields. */
export interface MessageStoreOpts {readonly inbox?:boolean;readonly currentUser?:boolean}

/** mail_message.py _store_message_fields for internal users of partner threads.
 * The caller has validated the thread and selected messages within that thread. */
export async function messageFields(env:Environment,ids:number[],store:Store,formatReply=true,opts:MessageStoreOpts={}):Promise<void>{
  const self=await userInfo(env),partners=new MailBootstrap(env,store);
  const fields=['attachment_ids','author_guest_id','author_id','body','create_date','date','email_from','incoming_email_cc','incoming_email_to','message_type','model','partner_ids','partner_cc_ids','parent_id','pinned_at','reply_to','res_id','subject','subtype_id','write_date','notification_ids','bookmarked_partner_ids','reaction_ids','message_link_preview_ids','started_poll_ids','ended_poll_ids'];
  const rows=await env.sudo().model('mail.message').read(ids,fields,'web');
  // tools/discuss.py:909-931 `is_for_internal_users` without a bus target: the current user. A share user's Store of a
  // thread message (the portal chatter's post) has no email_from/reply_to (unless the message has no author) and no
  // notifications (mail_message.py:1224-1228, 1248-1251, 1270-1276); channel messages keep the port's former shape
  const shareUser=!(await userFlags(env.cr,env.uid)).isInternal;
  for(const m of rows){
    if((m['message_link_preview_ids'] as number[]).length)throw new NotPorted('chatter message message_link_preview_ids');
    // mail_message.py:1256-1263 the polls of a message with one (`has_poll`): its record first, so a start message
    // added through its poll comes after it, as Odoo's Store inserts the outer record before its relations
    const started=m['started_poll_ids'] as number[],ended=m['ended_poll_ids'] as number[],hasPoll=started.length>0||ended.length>0;
    if(hasPoll)store.add('mail.message',Number(m['id']));
    // mail_message.py:1202 attachment_ids (sudo, sorted by id), with the ownership token for their author (:1407)
    const own=m['author_id']===self.partnerId;
    for(const aid of [...m['attachment_ids'] as number[]].sort((a,b)=>a-b))store.add('ir.attachment',aid,{...await attachmentStoreFields(env,aid),...(own?{ownership_token:await ownershipToken(env,aid)}:{})});
    if(String(m['body']).includes('data-oe-type="call"')||String(m['body']).includes('o_message_redirect'))throw new NotPorted('chatter header/call/linked-message fields');
    const mid=Number(m['id']),tid=Number(m['res_id']),model=String(m['model']);
    if(model!=='res.partner'&&model!=='discuss.channel'&&!isGenericThread(model))throw new NotPorted('message Store outside partner/channel threads');
    const channel=model==='discuss.channel';
    // discuss/mail_message.py:35 _store_extra_fields: the parent of channel messages (format_reply)
    // discuss/mail_message.py:35-45: the parent of a channel message, itself without its parent (format_reply=False)
    // mail_message.py:1211 `res.one("author_guest_id", "_store_avatar_fields", sudo=True)`, before the author
    if(m['author_guest_id'])await partners.guestAvatar(Number(m['author_guest_id']));
    if(m['author_id'])await partners.author(Number(m['author_id']));
    for(const pid of [...m['partner_ids'] as number[]].sort((a,b)=>a-b))await partners.avatar(pid);
    if(!channel)for(const pid of [...m['partner_cc_ids'] as number[]].sort((a,b)=>a-b))await partners.avatar(pid);
    if(m['subtype_id']){
      const subtype=(await env.sudo().model('mail.message.subtype').read([Number(m['subtype_id'])],['description'],'web'))[0]!;
      store.add('mail.message.subtype',Number(subtype['id']),{description:subtype['description']});
    }
    if(hasPoll){
      await addPollFields(env,store,[...started].sort((a,b)=>a-b),false,async()=>undefined,opts.currentUser);
      await addPollFields(env,store,[...ended].sort((a,b)=>a-b),true,async(start)=>messageFields(env,[start],store,true,opts),opts.currentUser);
    }
    const notices=await env.sudo().model('mail.notification').read(m['notification_ids'] as number[],['failure_type','mail_message_id','notification_status','notification_type','res_partner_id','mail_email_address','is_read'],'web');
    const forShare=shareUser&&!channel;
    for(const n of forShare?[]:notices){const {is_read:_,...values}=n;store.add('mail.notification',Number(n['id']),values);
      if(n['res_partner_id']){const p=(await env.sudo().model('res.partner').read([Number(n['res_partner_id'])],['name','email'],'web'))[0]!;store.add('res.partner',Number(p['id']),{name:p['name'],email:p['email'],...(!p['name']?{display_name:(await env.sudo().model('res.partner').displayName([Number(p['id'])])).get(Number(p['id']))}:{})});}
    }
    const {bookmarked_partner_ids,linked_message_ids:_,reaction_ids:__,started_poll_ids:___,ended_poll_ids:____,parent_id,partner_cc_ids,...values}=m;
    if(forShare){
      delete values['notification_ids'];
      if(m['author_id']||m['author_guest_id']){delete values['email_from'];delete values['reply_to'];}
    }
    const name=(await env.sudo().model(model).displayName([tid])).get(tid);
    store.add('mail.message',mid,{...values,attachment_ids:[...m['attachment_ids'] as number[]].sort((a,b)=>a-b),record_name:name??false,body:markup(m['body']),partner_ids:[...m['partner_ids'] as number[]].sort((a,b)=>a-b),
      ...(channel?(formatReply?{parent_id:parent_id??false}:{}):{partner_cc_ids:[...partner_cc_ids as number[]].sort((a,b)=>a-b)}),reactions:await reactionGroups(env,mid,store),thread:{id:tid,model},
      ...(hasPoll?{started_poll_ids:[...started].sort((a,b)=>a-b),ended_poll_ids:[...ended].sort((a,b)=>a-b)}:{}),
      // mail_message.py:1350-1359: the incoming To/Cc headers as email_split_tuples when set
      ...(m['incoming_email_cc']?{incoming_email_cc:emailSplitTuples(String(m['incoming_email_cc']))}:{}),...(m['incoming_email_to']?{incoming_email_to:emailSplitTuples(String(m['incoming_email_to']))}:{}),
      is_bookmarked:(bookmarked_partner_ids as number[]).includes(self.partnerId),default_subject:textwrapShorten(name||'',100,'...'),scheduledDatetime:false, // mail_message.py:1283/1349: keyed by id, looked up by record: always False
      needaction:notices.some(n=>n['res_partner_id']===self.partnerId&&!n['is_read']),needaction_done:notices.some(n=>n['res_partner_id']===self.partnerId&&n['is_read']),
      ...(await ratingMessageFields(env,mid,model,store))});
    store.add('mail.thread',`${model}:${tid}`,{id:tid,model,display_name:name,has_mail_thread:true,...(await ratingThreadFields(env,model,tid)),
      ...(opts.inbox?await inboxThreadFields(env,model,tid,self.partnerId,store):{})});
    // mail_message.py:1383-1386 the extras last, per message: the parent right after its reply (tools/discuss.py
    // `_add_values` adds a record's relations as it adds the record), merged when it is also in the batch
    if(channel&&m['parent_id']&&formatReply)await messageFields(env,[Number(m['parent_id'])],store,false,opts);
  }
}

/** The models of the templates with a `_priority_field` (crm_lead.py:101, project_task.py:109, purchase_order.py:29,
 *  stock_picking.py:24; maintenance, mrp and repair are not installed): all name it `priority`. */
const PRIORITY_MODELS=new Set(['crm.lead','project.task','purchase.order','stock.picking']);

/**
 * mail_message.py:1286-1336 the thread's inbox fields (`inbox_fields` with the user as the Store's target): the icon of
 * the model's module, the user's follower of the record (`selfFollower`, the follower's `is_active` and `partner_id`),
 * and the record's priority with its selection (`fields_get`, in the user's language).
 */
async function inboxThreadFields(env:Environment,model:string,id:number,partnerId:number,store:Store):Promise<Record<string,unknown>>{
  const def=env.reg.model(model),out:Record<string,unknown>={};
  if(!def.moduleIcon)throw new NotPorted(`module icon of ${model}`);
  out['module_icon']=def.moduleIcon;
  if(model==='discuss.channel')out['selfFollower']=false;
  else{
    // mail_followers.py:37 is_active: related partner_id.active
    const f=(await env.cr.query<{id:number;is_active:boolean|null}>('SELECT f.id,p.active AS is_active FROM mail_followers f JOIN res_partner p ON p.id=f.partner_id WHERE f.res_model=$1 AND f.res_id=$2 AND f.partner_id=$3',[model,id,partnerId])).rows[0];
    if(f)store.add('mail.followers',f.id,{is_active:f.is_active??false,partner_id:partnerId});
    out['selfFollower']=f?f.id:false;
  }
  if(PRIORITY_MODELS.has(model)){
    const v=(await env.sudo().model(model).read([id],['priority'],'web'))[0]?.['priority']??false;
    out['priority']=v;
    out['priority_definition']=(await env.model(model).fieldsGet(['priority'],['selection']))['priority']?.['selection']??false;
  }
  return out;
}

/** mail_message.py:1108 `_store_reaction_group_fields`: groups by content over reaction_ids (_order id desc), sequence = min id. */
export async function reactionGroups(env:Environment,mid:number,store:Store,only?:string):Promise<unknown[]>{
  const rows=(await env.cr.query<{id:number;content:string;partner_id:number|null;guest_id:number|null}>(
    'SELECT id,content,partner_id,guest_id FROM mail_message_reaction WHERE message_id=$1 ORDER BY id DESC',[mid])).rows.filter(r=>only===undefined||r.content===only);
  const groups=new Map<string,{content:string;count:number;guests:number[];message:number;partners:number[];sequence:number}>();
  const partners=new MailBootstrap(env,store);
  for(const r of rows){
    let g=groups.get(r.content);
    if(!g)groups.set(r.content,g={content:r.content,count:0,guests:[],message:mid,partners:[],sequence:r.id});
    g.sequence=Math.min(g.sequence,r.id);
    g.count++;if(r.partner_id&&!g.partners.includes(r.partner_id)){g.partners.push(r.partner_id);await partners.avatar(r.partner_id);}
    // :1167 `res.one("guest_id", "_store_avatar_fields")` for a guest's reaction
    if(r.guest_id&&!g.guests.includes(r.guest_id)){g.guests.push(r.guest_id);await partners.guestAvatar(r.guest_id);}
  }
  return [...groups.values()];
}
