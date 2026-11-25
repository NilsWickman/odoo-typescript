/** mail/controllers/store.py and tools/store_handler.py request loop. */
import './write_hooks';
import './actions';
import './post';
import './activity';
import './discuss';
import './typing';
import './attachment';
import './mention';
import './search';
import { NotPorted } from '../errors';
import { setMessageDone } from './busnotify';
import { storeVersion } from '../bus/presence';
import { jsonRoute } from '../http/router';
import { parseDomain, cond, and } from '../orm/domain';
import type { Domain, Environment } from '../orm/types';
import { busLastId } from '../bus/bus';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import { Store } from './store';
import { initChannelIds, storeChannels, channelMembers, channelCounters, loadMoreChannels, lastMessages, checkNoNeedaction, hasHiddenChannels } from './channels';
import { failures, activityGroups } from './menu';
import { MailBootstrap } from './bootstrap';
import { checkThread, fetchMessages, threadFields, messageFields } from './thread';
import { isGenericThread, checkGenericThread, fetchGenericMessages, genericThreadFields, activitiesByIds, permissionOn, postAccessOf } from './thread_generic';
import { fetchPortalMessages, portalMessageFormat } from './portal_format';

/**
 * messaging_menu.py:14-53 `_get_menu_tab_full_domain`: the bookmark tab, the notification tab (the user's
 * notifications) and its `notification_unread` filter (`needaction`); another tab or filter is Odoo's BadRequest.
 */
async function menuTabDomain(env:Environment,tab:string,filters:readonly string[]):Promise<Domain>{
  const pid=(await userInfo(env)).partnerId;
  let domain:Domain;
  if(tab==='bookmark')domain=cond('bookmarked_partner_ids','=',pid);
  else if(tab==='notification')domain=cond('notification_ids.res_partner_id','=',pid);
  else throw new NotPorted(`messaging menu tab ${tab} (BadRequest)`);
  for(const f of filters){
    if(tab!=='notification'||f!=='notification_unread')throw new NotPorted(`messaging menu filter ${f} of ${tab} (BadRequest)`);
    domain=and([domain,cond('needaction','=',true)]);
  }
  return domain;
}

/** webclient.py:26-38 the threads of the messages that are mail.thread records: `message_needaction_counter` (sudo,
 *  mail_thread.py:279-293: the user's unread notifications of the thread's messages that are not user notifications)
 *  and the bus' last id. */
async function needactionCounters(env:Environment,ids:number[],store:Store):Promise<void>{
  if(!ids.length)return;
  const pid=(await userInfo(env)).partnerId,bus=await busLastId(env.cr);
  const seen=new Set<string>();
  const byId=new Map((await env.cr.query<{id:number;model:string|null;res_id:number|null}>('SELECT id,model,res_id FROM mail_message WHERE id=ANY($1::int[])',[ids])).rows.map(r=>[r.id,r]));
  for(const id of ids){
    const m=byId.get(id);
    if(!m?.model||!m.res_id||seen.has(`${m.model}:${m.res_id}`))continue;
    seen.add(`${m.model}:${m.res_id}`);
    if(!env.reg.model(m.model).isMailThread)throw new NotPorted(`needaction counter of ${m.model}`);
    const n=(await env.cr.query<{n:string}>(`SELECT count(*)::text AS n FROM mail_message msg JOIN mail_notification rel ON rel.mail_message_id=msg.id
        AND rel.res_partner_id=$1 AND (rel.is_read=false OR rel.is_read IS NULL)
      WHERE msg.model=$2 AND msg.res_id=$3 AND msg.message_type!='user_notification'`,[pid,m.model,m.res_id])).rows[0]!;
    store.add('mail.thread',`${m.model}:${m.res_id}`,{id:m.res_id,model:m.model,message_needaction_counter:Number(n.n),message_needaction_counter_bus_id:bus});
  }
}

jsonRoute('/mail/store',async ctx=>{
  const params=ctx.jsonParams??{},context=(params['context']??{}) as Record<string,unknown>;
  let env=await ctx.orm();
  if(context['uid']&&context['uid']!==env.uid)return {};
  env=env.withContext({...env.context,...context});
  const store=new Store(),flags=await userFlags(env.cr,env.uid);
  const fetch=params['fetch_params'];
  if(!Array.isArray(fetch))throw new NotPorted('mail/store malformed fetch_params');
  let init=false,lastMessage=false,lastNeedaction=false,inboxFields=false;
  const messages:number[]=[],channels:number[]=[],done:number[]=[];
  for(const entry of fetch){
    const name=typeof entry==='string'?entry:entry[0];
    const args=(typeof entry==='string'?{}:entry[1]??{}) as Record<string,unknown>;
    const dataId=typeof entry!=='string'&&entry[2]!=null?Number(entry[2]):null;
    if(dataId!==null&&name!=='/mail/thread/messages'&&name!=='/mail/chatter_fetch'&&name!=='/mail/messaging_menu/discuss.channel/load_more'&&name!=='/mail/messaging_menu/mail.message/load_more'&&name!=='/discuss/channel/messages')throw new NotPorted('mail/store data request id');
    switch(name){
      case 'init_messaging':init=true;for(const id of await initChannelIds(env))if(!channels.includes(id))channels.push(id);break;
      case '/mail/messaging_menu/discuss.channel/load_more':{
        const {ids,fullyLoaded}=await loadMoreChannels(env,args);
        for(const id of ids)if(!channels.includes(id))channels.push(id);
        lastMessage=true;lastNeedaction=true;
        // tools/store_handler.py resolve_data_request: the DataResponse of the request id
        if(dataId===null)throw new NotPorted('load_more without a data request id');
        store.add('DataResponse',dataId,{_resolve:true,is_fully_loaded:fullyLoaded},false);
        // messaging_menu.py: `store.add(channels, ...)` of a recordset, even an empty one, carries the store version
        store.markVersioned();
        break;
      }
      case 'failures':if(flags.isInternal)await failures(env,store);break;
      case 'systray_get_activities':if(flags.isInternal)await activityGroups(env,store);break;
      // webclient.py:94-99 (audience internal: skipped for other users, store_handler.py:54-58)
      case 'mail.activity':if(flags.isInternal)await activitiesByIds(env,args['ids'],store);break;
      // discuss/channel.py:42-57 (audience everyone)
      case 'has_hidden_channels':await hasHiddenChannels(env,store);break;
      case '/mail/messaging_menu/initialize_counters':{
        const types=args['filter_id_by_tab_id_by_record_type'] as Record<string,Record<string,unknown>>;
        if(types['mail.message']){
          for(const [tab,filter] of Object.entries(types['mail.message'])){
            const domain=await menuTabDomain(env,tab,filter?[String(filter)]:[]);
            // Empty candidates need no record-access evaluation; otherwise use
            // the ORM's full message access path, which may refuse unported rules.
            const candidates=await env.sudo().model('mail.message').search(domain);
            const ids=candidates.length?await env.model('mail.message').search(parseDomain([['id','in',candidates]])):[];
            store.add('MessagingMenuTab',tab,{init_counter_ids:ids},false);
          }
        }
        if(types['discuss.channel'])await channelCounters(env,store,types['discuss.channel']);
        break;
      }
      // messaging_menu.py:87-108 the notification (inbox) tab's next messages, with the inbox fields
      case '/mail/messaging_menu/mail.message/load_more':{
        if(dataId===null)throw new NotPorted('load_more without a data request id');
        if(args['search_term'])throw new NotPorted('messaging menu search');
        const filters=Array.isArray(args['filter_ids'])?(args['filter_ids'] as unknown[]).map(String):[];
        const exclude=Array.isArray(args['exclude_ids'])?args['exclude_ids'] as number[]:[];
        let domain=await menuTabDomain(env,String(args['tab_id']),filters);
        if(exclude.length)domain=and([domain,cond('id','not in',exclude)]);
        const limit=Number(args['limit']);
        if(!Number.isInteger(limit)||limit<=0)throw new NotPorted('messaging menu load_more without a limit');
        // mail_message.py:984-1039 `_message_fetch` as the user: `search(domain, limit, order='id DESC')`
        const ids=await env.model('mail.message').search(domain,{limit,order:'id DESC'});
        store.add('DataResponse',dataId,{_resolve:true,messages:ids,is_fully_loaded:ids.length<limit},false);
        store.markVersioned();
        for(const id of ids)if(!messages.includes(id))messages.push(id);
        if(ids.length)inboxFields=true;
        break;
      }
      case 'discuss.channel':{
        // discuss/channel.py:60-65 store_add_discuss_channel_to_context: the readable channels join the request's
        // channels, with their last message when asked
        const ids=Array.isArray(args['ids'])?args['ids'] as unknown[]:[];
        for(const id of await env.model('discuss.channel').search(cond('id','in',ids)))if(!channels.includes(id))channels.push(id);
        if(args['with_last_message'])lastMessage=true;
        break;
      }
      // discuss/channel.py:67-91 (audience everyone)
      case '/discuss/channel/members':await channelMembers(env,store,args);break;
      case 'res.partner':{
        const ids=await env.model('res.partner').search(cond('id','=',args['id']));
        for(const id of ids)await new MailBootstrap(env,store).partner(id,true);
        break;
      }
      case '/discuss/channel/messages':{
        // discuss/channel.py:110: the member's channel, `_message_fetch` (mail_message.py:984), set_message_done
        const cid=Number(args['channel_id']);
        if(dataId===null)throw new NotPorted('channel messages without a data request id');
        const visible=await env.model('discuss.channel').search(cond('id','=',cid));
        if(!visible.length)break;
        const fp=(args['fetch_params']??{}) as Record<string,unknown>;
        for(const k of Object.keys(fp))if(!['limit','around','before','after'].includes(k))throw new NotPorted(`channel message fetch ${k}`);
        const limit=Number(fp['limit']??30),base=[['model','=','discuss.channel'],['res_id','=',cid],['message_type','!=','user_notification']];
        const M=env.sudo().model('mail.message');
        let ids:number[];
        if(fp['around']!==undefined&&fp['around']!==null){
          const around=Number(fp['around']);
          const before=await M.search(parseDomain([...base,['id','<=',around]]),{limit:Math.floor(limit/2),order:'id DESC'});
          const after=await M.search(parseDomain([...base,['id','>',around]]),{limit:Math.floor(limit/2),order:'id ASC'});
          ids=[...after,...before].sort((a,b)=>b-a);
        }else{
          const d:unknown[]=[...base];if(fp['before'])d.push(['id','<',Number(fp['before'])]);if(fp['after'])d.push(['id','>',Number(fp['after'])]);
          ids=await M.search(parseDomain(d),{limit,order:fp['after']?'id ASC':'id DESC'});
          if(fp['after'])ids.sort((a,b)=>b-a);
        }
        store.add('DataResponse',dataId,{_resolve:true,messages:ids},false);
        store.markVersioned();
        messages.push(...ids);done.push(...ids);
        const last=await lastMessages(env,[cid]);
        if(last.every(m=>ids.includes(m)))store.add('discuss.channel',cid,{last_message_fetched:true});
        break;
      }
      // portal/controllers/thread.py:77-149 for a logged-in user on a generic thread. A share user's thread fields
      // follow `_store_portal_thread_fields` (can_react through `_mail_post_access`); access parameters (token, hash,
      // pid: the portal partner) are ported for internal users only
      case '/portal/chatter_init':{
        const id=Number(args['thread_id']),model=String(args['thread_model']);
        if(flags.isPublic||!isGenericThread(model))throw new NotPorted('portal chatter of the public user or on a non-generic thread');
        const access=(args['access_params']??{}) as Record<string,unknown>;
        if(!flags.isInternal&&Object.values(access).some(v=>v!==undefined&&v!==null&&v!==''&&v!==false))throw new NotPorted('portal chatter of a share user with access parameters (portal partner)');
        if(model==='calendar.event')throw new NotPorted('portal chatter on calendar.event (_mail_get_operation_for_mail_message_operation)');
        if(await moduleInstalled(env,'website'))throw new NotPorted('portal chatter with website (is_user_publisher)');
        const boot=new MailBootstrap(env,store);
        await boot.init(await findOrCreateSettings(env));
        const readable=flags.isInternal?await checkGenericThread(env,model,id):await permissionOn(env,model,id,'read');
        if(readable){
          if(!flags.isInternal){
            const name=(await env.model(model).displayName([id])).get(id)??false;
            const canReact=await permissionOn(env,model,id,postAccessOf(model));
            store.add('mail.thread',`${model}:${id}`,{id,model,can_react:canReact,display_name:name,hasReadAccess:true,portal_partner:false});
            break;
          }
          const token=(args['access_params'] as Record<string,unknown>|undefined)?.['token'];
          const table=env.reg.model(model).table;
          const row=(await env.sudo().cr.query<{access_token:string|null;partner_id:number|null}>(`SELECT access_token,partner_id FROM "${table}" WHERE id=$1`,[id])).rows[0];
          const portal=token&&row?.access_token===token?row.partner_id:null;
          const name=(await env.sudo().model(model).displayName([id])).get(id)??false;
          store.add('mail.thread',`${model}:${id}`,{id,model,can_react:true,display_name:name,hasReadAccess:true,portal_partner:portal??false});
          if(portal){
            const u=(await env.sudo().cr.query<{id:number}>('SELECT id FROM res_users WHERE partner_id=$1 LIMIT 1',[portal])).rows;
            if(u.length)throw new NotPorted('portal partner with a user');
            const p=(await env.sudo().cr.query<{active:boolean}>('SELECT active FROM res_partner WHERE id=$1',[portal])).rows[0];
            await boot.avatar(portal);
            store.add('res.partner',portal,{active:p?.active??false,main_user_id:false});
          }
        }
        break;
      }
      // portal/controllers/thread.py:35-75 with the share domain and portal_message_format (src/mail/portal_format.ts)
      case '/mail/chatter_fetch':{
        const id=Number(args['thread_id']),model=String(args['thread_model']);
        if(flags.isPublic||!isGenericThread(model))throw new NotPorted('portal chatter of the public user or on a non-generic thread');
        const readable=flags.isInternal?await checkGenericThread(env,model,id):await permissionOn(env,model,id,'read');
        const token=((args['access_params']??{}) as Record<string,unknown>)['token'];
        if(!readable&&token)throw new NotPorted('portal chatter through an access token (_get_thread_with_access with token)');
        if(!flags.isInternal&&token)throw new NotPorted('portal chatter of a share user with an access token (portal partner)');
        if(readable){
          for(const k of Object.keys(args))if(!['thread_id','thread_model','fetch_params','access_params'].includes(k))throw new NotPorted(`chatter_fetch ${k}`);
          const ids=await fetchPortalMessages(env,model,id,(args['fetch_params']??{}) as Record<string,unknown>);
          if(dataId!==null)store.add('DataResponse',dataId,{_resolve:true,messages:ids},false);
          // `res.many("messages", [], value=messages)`: a recordset, even an empty one, versions the Store
          store.markVersioned();
          await portalMessageFormat(env.sudo(),ids,store);
        }
        break;
      }
      case '/mail/thread/messages':{
        const id=Number(args['thread_id']);
        if(Object.keys((args['access_params']??{}) as object).length)throw new NotPorted('thread access tokens');
        const tmodel=String(args['thread_model']);
        // non-partner threads (crm.lead): thread_generic.ts
        if(isGenericThread(tmodel)){if(await checkGenericThread(env,tmodel,id))messages.push(...await fetchGenericMessages(env,tmodel,id,(args['fetch_params']??{}) as Record<string,unknown>,store,dataId));}
        else if(await checkThread(env,tmodel,id)){const fetched=await fetchMessages(env,id,(args['fetch_params']??{}) as Record<string,unknown>,store,dataId);messages.push(...fetched);done.push(...fetched);}
        break;
      }
      case 'mail.thread':{
        const id=Number(args['thread_id']),model=String(args['thread_model']);
        // an access token changes nothing for an internal user who reads the record
        if(Object.keys((args['access_params']??{}) as object).length&&!(flags.isInternal&&isGenericThread(model)))throw new NotPorted('thread access tokens');
        // webclient.py:45-65: a share user's request list is emptied (the access fields only)
        if(isGenericThread(model)&&!flags.isInternal&&!flags.isPublic){
          if(await permissionOn(env,model,id,'read'))await genericThreadFields(env,model,id,[],store);
          else store.add('mail.thread',`${model}:${id}`,{id,model,hasReadAccess:false,hasWriteAccess:false});
        }
        else if(isGenericThread(model)){if(await checkGenericThread(env,model,id))await genericThreadFields(env,model,id,args['request_list'] as string[],store);
          else store.add('mail.thread',`${model}:${id}`,{id,model,hasReadAccess:false,hasWriteAccess:false});}
        else if(await checkThread(env,model,id))await threadFields(env,id,args['request_list'] as string[],store);
        else store.add('mail.thread',`${model}:${id}`,{id,model,hasReadAccess:false,hasWriteAccess:false});
        break;
      }
      default:throw new NotPorted(`mail/store handler ${name}`);
    }
  }
  // webclient.py:168-169 set_message_done of the fetched thread messages; the Store is evaluated afterwards
  // (lazy values), so the messages serialize as read and the version reports the notification writes
  const written:Record<string,Record<string,string[]>>={};
  if(done.length&&!(await userFlags(env.cr,env.uid)).isPublic){
    const ids=await setMessageDone(ctx,env,done,(await userInfo(env)).partnerId);
    if(ids.length)written['mail.notification']=Object.fromEntries(ids.map(id=>[String(id),['is_read','read_date']]));
  }
  // webclient.py:15-41: the messages with the inbox fields when a handler asked for them, then each mail.thread
  // record's needaction counter as the user (mail_thread.py:279-293) and the bus' last id
  await messageFields(env,[...new Set(messages)],store,true,{inbox:inboxFields,currentUser:true});
  if(inboxFields)await needactionCounters(env,[...new Set(messages)],store);
  // discuss/channel.py:28-40: the request's channels, then their last messages
  if(channels.length)await storeChannels(env,store,channels);
  // the polls of the last messages in the user's Store (mail_poll_option.py:99-102 selected_by_self)
  if(lastMessage){await messageFields(env,await lastMessages(env,channels),store,true,{currentUser:true});for(const id of channels)store.add('discuss.channel',id,{last_message_fetched:true});}
  if(lastNeedaction)await checkNoNeedaction(env,channels);
  const out=await store.asDict(env.cr);
  if(Object.keys(written).length&&out['__store_version__'])out['__store_version__']=await storeVersion(env.cr,written);
  return out;
},{auth:'public',readonly:true,methods:['POST']});

/** res_users_settings.py:24-34 `_find_or_create_for_user` (the table is outside the harness's database diff). */
async function findOrCreateSettings(env:Environment):Promise<number>{
  const q=async()=>(await env.cr.query<{id:number}>('SELECT id FROM res_users_settings WHERE user_id=$1 ORDER BY id LIMIT 1',[env.uid])).rows[0]?.id;
  let id=await q();
  if(id===undefined){
    await env.cr.query(`INSERT INTO res_users_settings (user_id, create_uid, create_date, write_uid, write_date)
      VALUES ($1, $1, now() AT TIME ZONE 'UTC', $1, now() AT TIME ZONE 'UTC')`,[env.uid]);
    id=await q();
  }
  if(id===undefined)throw new Error('res_users_settings insert failed');
  return id;
}

async function moduleInstalled(env:Environment,name:string):Promise<boolean>{
  return (await env.cr.query("SELECT 1 FROM ir_module_module WHERE name=$1 AND state='installed'",[name])).rows.length>0;
}
