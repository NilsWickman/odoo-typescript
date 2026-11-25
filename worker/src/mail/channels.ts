/** mail/models/discuss/discuss_channel{,_member}.py: membership, init_messaging,
 * _store_channel_fields and messaging_menu.py counter domains. */
import { NotPorted } from '../errors';
import { userInfo } from '../orm/env';
import { registerHooks } from '../orm/hooks';
import { and, cond, or, TRUE } from '../orm/domain';
import type { Environment } from '../orm/types';
import { userFlags, xmlidToResId } from '../session/user';
import { limitedFieldAccessToken, dbNow, todayInTz, validTz } from '../models/util';
import { MailBootstrap } from './bootstrap';
import { Store } from './store';
import { messageFields } from './thread';

registerHooks('discuss.channel',{search:{is_member:async(env,op)=>{
  if(op!=='in')throw new NotPorted(`discuss.channel.is_member ${op}`);
  const flags=await userFlags(env.cr,env.uid);
  if(env.context['guest'])throw new NotPorted('channel membership of guest');
  const ids=flags.isPublic?[]:(await env.cr.query<{channel_id:number}>('SELECT channel_id FROM discuss_channel_member WHERE partner_id=$1',[(await userInfo(env)).partnerId])).rows.map(r=>r.channel_id);
  return cond('id','in',ids);
}}});

/** webclient.py init_messaging: the channels it adds to the request context. */
export async function initChannelIds(env:Environment):Promise<number[]> {
  const self=await userInfo(env),flags=await userFlags(env.cr,env.uid);
  if(flags.isPublic)throw new NotPorted('public init_messaging persona');
  const bot=await xmlidToResId(env.cr,'base.partner_root');
  const candidates=(await env.cr.query<{id:number}>(`SELECT c.id FROM discuss_channel c WHERE c.active AND (
    EXISTS(SELECT 1 FROM discuss_channel_member m WHERE m.channel_id=c.id AND m.partner_id=$1 AND m.rtc_inviting_session_id IS NOT NULL)
    OR ($2 AND c.channel_type='chat' AND EXISTS(SELECT 1 FROM discuss_channel_member m WHERE m.channel_id=c.id AND m.partner_id=$1)
      AND EXISTS(SELECT 1 FROM discuss_channel_member m WHERE m.channel_id=c.id AND m.partner_id=$3)))`,[self.partnerId,flags.isInternal,bot])).rows.map(r=>r.id);
  return env.model('discuss.channel').search(cond('id','in',candidates));
}

/** discuss/channel.py:28-40 (end of `_process_request_loop`): `_store_channel_fields` of the request's channels. */
export async function storeChannels(env:Environment,store:Store,ids:readonly number[]):Promise<void> {
  const self=await userInfo(env);
  const bus=(await env.cr.query<{id:number|null}>('SELECT max(id) AS id FROM bus_bus')).rows[0]?.id??0;
  const partners=new MailBootstrap(env,store),done=new Set<number>();
  for(const id of ids)await storeChannel(env,store,id,{self:self.partnerId,bus,partners,done,request:new Set(ids)});
}

interface ChannelStoreCtx {self:number;bus:number;partners:MailBootstrap;done:Set<number>;request:ReadonlySet<number>}

/**
 * discuss_channel.py:1641-1748 `_store_channel_fields` of one channel. Store relations are added per record, in the
 * order of the field list (tools/discuss.py `_add_values`: the record's index first, then each relation as it comes):
 * discuss_category_id, channel_member_ids (non-lazy types), from_message_id, group_public_id, parent_channel_id (the
 * parent's own `_store_channel_fields`), self_member_id.
 */
async function storeChannel(env:Environment,store:Store,id:number,cx:ChannelStoreCtx):Promise<void> {
  if(cx.done.has(id))return;
  cx.done.add(id);
  const {bus,partners}=cx;
  const c=(await env.model('discuss.channel').read([id],['channel_type','create_uid','default_display_mode','discuss_category_id','last_interest_dt','member_indices','name','uuid'],'web'))[0]!;
  const isChannel=c['channel_type']==='channel';
  if(c['channel_type']!=='chat'&&!isChannel)throw new NotPorted('Store channel group fields');
  if(await env.sudo().model('discuss.channel').binaryValue(id,'image_128'))throw new NotPorted('Store uploaded channel avatar');
  if(c['default_display_mode']==='video_full_screen')throw new NotPorted('Store video call channel fields');
  const allMembers=await env.cr.query<{id:number;partner_id:number|null;guest_id:number|null;rtc_inviting_session_id:number|null}>('SELECT id,partner_id,guest_id,rtc_inviting_session_id FROM discuss_channel_member WHERE channel_id=$1 ORDER BY id',[id]);
  // discuss_channel.py:1649-1659: channels load their members lazily, only the user's (and invited ones) are sent
  const members={rows:isChannel?allMembers.rows.filter(m=>m.partner_id===cx.self):allMembers.rows};
  let channelFields:Record<string,unknown>={},groupPublic:number|false=false,fromMessage:number|false=false,parent:number|false=false;
  if(isChannel){
    const x=(await env.sudo().model('discuss.channel').read([id],['description','from_message_id','group_ids','group_public_id','is_readonly','parent_channel_id','avatar_cache_key','create_date'],''))[0]!;
    const m2o=(v:unknown):number|false=>typeof v==='number'?v:Array.isArray(v)?v[0] as number:false;
    fromMessage=m2o(x['from_message_id']);parent=m2o(x['parent_channel_id']);groupPublic=m2o(x['group_public_id']);
    const invited=(await env.cr.query('SELECT 1 FROM discuss_channel_member WHERE channel_id=$1 AND rtc_inviting_session_id IS NOT NULL LIMIT 1',[id])).rows.length;
    if(invited)throw new NotPorted('Store invited channel members');
    channelFields={description:x['description'],from_message_id:fromMessage,group_ids:x['group_ids'],group_public_id:groupPublic,is_readonly:x['is_readonly'],parent_channel_id:parent,
      avatar_cache_key:x['avatar_cache_key']};
    if(parent){
      // is_meeting (a thread): create_date, meeting_start/stop_dt (_compute_meeting_dt :465-477, false unless the
      // parent is a video call) and message_count (:486-497, comments and emails of the thread)
      const p=(await env.sudo().cr.query<{mode:string|null}>('SELECT default_display_mode AS mode FROM discuss_channel WHERE id=$1',[parent])).rows[0];
      if(p?.mode==='video_full_screen')throw new NotPorted('Store thread of a video call meeting');
      const n=(await env.cr.query<{n:string}>(`SELECT count(*)::text n FROM mail_message WHERE model='discuss.channel' AND res_id=$1
        AND message_type NOT IN ('user_notification','notification')`,[id])).rows[0];
      Object.assign(channelFields,{create_date:x['create_date'],meeting_start_dt:false,meeting_stop_dt:false,message_count:Number(n?.n??0)});
    }
  }
  const sessions=(await env.cr.query<{id:number}>('SELECT id FROM discuss_channel_rtc_session WHERE channel_id=$1',[id])).rows;
  if(sessions.length||members.rows.some(m=>m.rtc_inviting_session_id||m.guest_id))throw new NotPorted('Store RTC/guest channel members');
  const permission=await env.model('discuss.channel').accessDomain('write');
  const editable=(await env.sudo().model('discuss.channel').search(and([cond('id','=',id),permission??TRUE]))).length>0;
  const needaction=(await env.cr.query<{n:string}>(`SELECT count(*)::text n FROM mail_message m JOIN mail_notification n ON n.mail_message_id=m.id
    WHERE m.model='discuss.channel' AND m.res_id=$1 AND n.res_partner_id=$2 AND NOT n.is_read`,[id,cx.self])).rows[0];
  const {member_indices:_mi,...channelValues}=c;
  store.add('discuss.channel',id,{...(isChannel?channelValues:c),avatar_cache_key:'no-avatar',avatar_128_access_token:await limitedFieldAccessToken(env,'discuss.channel',id,'avatar_128','binary'),
    fetchChannelInfoState:'fetched',is_editable:editable,member_count:allMembers.rows.length,message_needaction_counter:Number(needaction?.n??0),message_needaction_counter_bus_id:bus,...channelFields});
  // discuss_category.py:45-48 `_store_category_fields` (sudo)
  const category=typeof c['discuss_category_id']==='number'?c['discuss_category_id']:Array.isArray(c['discuss_category_id'])?c['discuss_category_id'][0] as number:false;
  if(category){
    const k=(await env.sudo().model('discuss.category').read([category],['name','sequence'],''))[0]!;
    store.add('discuss.category',category,{name:k['name'],sequence:k['sequence'],bus_channel_access_token:await limitedFieldAccessToken(env,'discuss.category',category,'id','bus.channel')});
  }
  const addMember=async(m:{id:number;partner_id:number|null}):Promise<void>=>{
    // discuss/channel.py:31 `store.add(channels.self_member_id, ["is_favorite"])`: the request's channels only
    const extra=m.partner_id===cx.self?['custom_notifications','last_interest_dt','mute_until_dt','new_message_separator','rtc_inviting_session_id','unpin_dt',...(cx.request.has(id)?['is_favorite']:[])]:[];
    await storeMember(env,store,partners,m,extra,async()=>{
      if(m.partner_id!==cx.self)return;
      const unread=await unreadCount(env,m.id);
      store.add('discuss.channel.member',m.id,{message_unread_counter:unread,message_unread_counter_bus_id:bus});
    });
  };
  // `channel_member_ids` in id order (the S3 reference: a self member with the higher id comes second)
  if(!isChannel)for(const m of members.rows)await addMember(m);
  if(fromMessage)await messageFields(env,[fromMessage],store,true,{currentUser:true});
  if(groupPublic){
    const g=(await env.sudo().model('res.groups').read([groupPublic],['full_name'],''))[0]!;
    store.add('res.groups',groupPublic,{full_name:g['full_name']});
  }
  if(parent)await storeChannel(env,store,parent,cx);
  if(isChannel)for(const m of members.rows)await addMember(m);
}

/** discuss_channel_member.py:502-506 `_store_member_fields` with :462-474 the persona (a partner's
 *  `_store_partner_fields` and `_store_mention_fields`); `extra` fields of the same record, `between` what the
 *  member adds before its partner. */
export async function storeMember(env:Environment,store:Store,partners:MailBootstrap,m:{id:number;partner_id:number|null;guest_id?:number|null},extra:readonly string[]=[],between?:()=>Promise<void>):Promise<void> {
  // :480-496 `_store_persona`: `partner_id` or `guest_id`, each only when set (its predicate)
  const persona=m.partner_id?['partner_id']:m.guest_id?['guest_id']:[];
  const fields=['channel_id','channel_role','create_date','invitation_sent_dt','last_seen_dt','seen_message_id',...persona,...extra];
  const row=(await env.sudo().model('discuss.channel.member').read([m.id],fields,'web'))[0]!;
  store.add('discuss.channel.member',m.id,row);
  if(between)await between();
  if(m.partner_id){await partners.partner(m.partner_id,true);store.add('res.partner',m.partner_id,{mention_token:await limitedFieldAccessToken(env,'res.partner',m.partner_id,'id','mail.message_mention')});}
  else if(m.guest_id)await storeGuest(env,store,m.guest_id);
}

/** mail_guest.py:157-163 `_store_avatar_fields` and, for internal users only (`internal=True`), `_store_im_status_fields`
 *  (:52-54 the presence's status or offline), sudo (discuss_channel_member.py:489). */
async function storeGuest(env:Environment,store:Store,id:number):Promise<void> {
  const g=(await env.cr.query<{name:string|null;write_date:string|null;status:string|null}>(`SELECT g.name,to_char(g.write_date,'YYYY-MM-DD HH24:MI:SS') write_date,
    (SELECT p.status FROM mail_presence p WHERE p.guest_id=g.id) status FROM mail_guest g WHERE g.id=$1`,[id])).rows[0];
  if(!g)throw new Error(`Missing mail.guest ${id}`);
  store.add('mail.guest',id,{avatar_128_access_token:await limitedFieldAccessToken(env,'mail.guest',id,'avatar_128','binary'),name:g.name||false,write_date:g.write_date??false});
  if((await userFlags(env.cr,env.uid)).isInternal)store.add('mail.guest',id,{im_status:g.status||'offline',
    im_status_access_token:await limitedFieldAccessToken(env,'mail.guest',id,'im_status','mail.presence')});
}

/**
 * discuss/channel.py:67-91 `store_get_discuss_channel_members`: the channel's member count and its members the client
 * does not know yet (the member list of a channel, its search), at most 100, in id order.
 */
export async function channelMembers(env:Environment,store:Store,args:Record<string,unknown>):Promise<void> {
  const channel=(await env.model('discuss.channel').search(cond('id','=',args['channel_id'])))[0];
  if(channel===undefined)return;
  const known=args['known_member_ids'],term=args['search_term'];
  const parts=[cond('channel_id','=',channel)];
  if(Array.isArray(known)&&known.length)parts.push(cond('id','not in',known));
  if(term){
    if(typeof term!=='string')throw new NotPorted('channel member search with a non-text term');
    parts.push(or([cond('partner_id.name','ilike',term),cond('guest_id.name','ilike',term)]));
  }
  const ids=await env.model('discuss.channel.member').search(and(parts),{limit:100});
  const c=(await env.model('discuss.channel').read([channel],['channel_type','member_count'],''))[0]!;
  // im_livechat's member and partner fields (discuss_channel_member.py:165-185) are not ported
  if(c['channel_type']==='livechat')throw new NotPorted('Store livechat channel members');
  store.add('discuss.channel',channel,{member_count:c['member_count']});
  const rows=ids.length?(await env.sudo().cr.query<{id:number;partner_id:number|null;guest_id:number|null}>(
    'SELECT id,partner_id,guest_id FROM discuss_channel_member WHERE id=ANY($1::int[])',[ids])).rows:[];
  const byId=new Map(rows.map(r=>[r.id,r]));
  const partners=new MailBootstrap(env,store);
  for(const id of ids)await storeMember(env,store,partners,byId.get(id)!);
}

export async function unreadCount(env:Environment,id:number):Promise<number> {
  const subtype=await xmlidToResId(env.cr,'mail.mt_important_notification');
  const row=(await env.cr.query<{n:string}>(`SELECT count(*)::text n FROM mail_message m JOIN discuss_channel_member cm ON cm.channel_id=m.res_id
    WHERE cm.id=$1 AND m.model='discuss.channel' AND m.message_type!='user_notification'
    AND (m.message_type!='notification' OR m.subtype_id=$2) AND m.id>=cm.new_message_separator`,[id,subtype])).rows[0];
  return Number(row?.n??0);
}

interface CounterChannel {id:number;channel_type:string;default_display_mode:string|null;parent_channel_id:number|null;parent_display:string|null;create_day:string;pinned:boolean;unread:boolean;important:boolean;muted:boolean}
export async function channelCounters(env:Environment,store:Store,tabs:Record<string,unknown>):Promise<void> {
  const self=await userInfo(env),flags=await userFlags(env.cr,env.uid),subtype=await xmlidToResId(env.cr,'mail.mt_important_notification');
  if(flags.isPublic||env.context['guest'])throw new NotPorted('public/guest channel counters');
  const tz=validTz(typeof env.context['tz']==='string'?env.context['tz']:null)??validTz(self.tz)??'UTC';
  // discuss_channel_member.py _search_is_pinned / _compute_sql_is_unread, and
  // discuss/messaging_menu.py important_domain. SQL only gathers candidates;
  // the ORM applies the channel read domain before any id is exposed.
  const rows=(await env.cr.query<CounterChannel>(`SELECT c.id,c.channel_type,c.default_display_mode,c.parent_channel_id,p.default_display_mode parent_display,
    to_char(c.create_date AT TIME ZONE 'UTC' AT TIME ZONE $4,'YYYY-MM-DD') create_day,
    coalesce(cm.unpin_dt IS NULL OR cm.last_interest_dt>=cm.unpin_dt OR c.last_interest_dt>=cm.unpin_dt,false) AND cm.id IS NOT NULL pinned,
    EXISTS(SELECT 1 FROM mail_message m WHERE m.model='discuss.channel' AND m.res_id=c.id AND m.message_type!='user_notification'
      AND (m.message_type!='notification' OR m.subtype_id=$3) AND m.id>=cm.new_message_separator) unread,
    ($2 AND EXISTS(SELECT 1 FROM mail_message m JOIN mail_notification n ON n.mail_message_id=m.id WHERE m.model='discuss.channel'
      AND m.res_id=c.id AND n.res_partner_id=$1 AND NOT n.is_read)) important,
    coalesce(cm.mute_until_dt > (now() AT TIME ZONE 'UTC'), false) muted
    FROM discuss_channel c LEFT JOIN discuss_channel p ON p.id=c.parent_channel_id
    LEFT JOIN discuss_channel_member cm ON cm.channel_id=c.id AND cm.partner_id=$1 WHERE c.active`,[self.partnerId,flags.isInternal,subtype,tz])).rows;
  const candidates=rows.filter(c=>c.important||(c.pinned&&c.unread&&!c.muted));
  const allowed=await env.model('discuss.channel').search(cond('id','in',candidates.map(c=>c.id)));
  const byId=new Map(candidates.map(c=>[c.id,c]));
  const today=todayInTz(await dbNow(env),tz);
  for(const [tab,filter] of Object.entries(tabs)) {
    if(!['chat','channel','meeting'].includes(tab))throw new NotPorted(`messaging tab ${tab}`);
    if(filter&&!['chat_unread','chat_group','channel_unread','channel_thread','meeting_today','meeting_unread','meeting_thread'].includes(String(filter)))throw new NotPorted(`messaging filter ${filter}`);
    const ids=allowed.filter(id=>{
      const c=byId.get(id)!;
      const match=tab==='chat'?['chat','group'].includes(c.channel_type)&&c.default_display_mode!=='video_full_screen'&&c.pinned:
        tab==='channel'?c.channel_type==='channel'&&(c.pinned||c.important):c.channel_type==='group'&&c.pinned&&(c.default_display_mode==='video_full_screen'||c.parent_display==='video_full_screen');
      if(!match)return false;
      if(!filter)return true;
      switch(filter){case 'chat_unread':case 'channel_unread':case 'meeting_unread':return c.unread;case 'chat_group':return c.channel_type==='group';case 'channel_thread':case 'meeting_thread':return !!c.parent_channel_id;case 'meeting_today':return c.default_display_mode==='video_full_screen'&&c.create_day===today;default:return false;}
    });
    store.add('MessagingMenuTab',tab,{init_counter_ids:ids},false);
  }
}

interface LoadMoreCandidate {id:number;channel_type:string;default_display_mode:string|null;parent_channel_id:number|null;parent_display:string|null;
  create_day:string;member:boolean;pinned:boolean;favorite:boolean;unread:boolean;needaction:boolean;ongoing:boolean}

/**
 * discuss/messaging_menu.py:102-138 `/mail/messaging_menu/discuss.channel/load_more`: the tab's domain
 * (`_get_menu_tab_domain` :12-43) ANDed with each filter's (`_get_menu_tab_filter_domain` :45-62; an unknown tab or
 * filter is Odoo's BadRequest), minus `exclude_ids`, `name ilike search_term`; favorites first (plus the meeting tab's
 * ongoing meetings, `_get_menu_tab_priority_domain`), then the others, both by last_interest_dt DESC, id DESC.
 * SQL only gathers the candidates; the ORM applies the channel read domain, order and limit. Returns the channel
 * ids and `is_fully_loaded`.
 */
export async function loadMoreChannels(env:Environment,args:Record<string,unknown>):Promise<{ids:number[];fullyLoaded:boolean}> {
  const tab=args['tab_id'],limit=Number(args['limit']),filters=((args['filter_ids']??[]) as unknown[]).map(String),exclude=((args['exclude_ids']??[]) as unknown[]).map(Number);
  const term=args['search_term'];
  if(tab!=='chat'&&tab!=='channel'&&tab!=='meeting')throw new NotPorted(`messaging menu load_more tab ${String(tab)} (BadRequest)`);
  const allowedFilters:Record<string,readonly string[]>={chat:['chat_unread','chat_group'],channel:['channel_unread','channel_thread'],meeting:['meeting_today','meeting_unread','meeting_thread']};
  for(const f of filters)if(!allowedFilters[tab]!.includes(f))throw new NotPorted(`messaging menu filter ${f} of ${tab} (BadRequest)`);
  if(term!==undefined&&term!==null&&term!==false&&typeof term!=='string')throw new NotPorted('messaging menu search_term that is not a string');
  if(!Number.isInteger(limit)||limit<=0)throw new NotPorted('messaging menu load_more limit');
  const self=await userInfo(env),flags=await userFlags(env.cr,env.uid);
  if(env.context['guest']||flags.isPublic)throw new NotPorted('guest/public messaging menu');
  const subtype=await xmlidToResId(env.cr,'mail.mt_important_notification');
  const tz=validTz(typeof env.context['tz']==='string'?env.context['tz']:null)??validTz(self.tz)??'UTC';
  // discuss_channel_member.py:158-173 _search_is_pinned, :207-225 _compute_sql_is_unread; mail_message.py:387-392
  // needaction (the user's notifications with is_read = False); discuss_channel.py:1143-1148 the ongoing meeting
  const rows=(await env.cr.query<LoadMoreCandidate>(`SELECT c.id,c.channel_type,c.default_display_mode,c.parent_channel_id,p.default_display_mode parent_display,
      to_char(c.create_date AT TIME ZONE 'UTC' AT TIME ZONE $4,'YYYY-MM-DD') create_day,
      cm.id IS NOT NULL member,
      cm.id IS NOT NULL AND coalesce(cm.unpin_dt IS NULL OR cm.last_interest_dt>=cm.unpin_dt OR c.last_interest_dt>=cm.unpin_dt,false) pinned,
      coalesce(cm.is_favorite,false) favorite,
      cm.id IS NOT NULL AND EXISTS(SELECT 1 FROM mail_message m WHERE m.model='discuss.channel' AND m.res_id=c.id AND m.message_type!='user_notification'
        AND (m.message_type!='notification' OR m.subtype_id=$3) AND m.id>=cm.new_message_separator) unread,
      EXISTS(SELECT 1 FROM mail_message m JOIN mail_notification n ON n.mail_message_id=m.id WHERE m.model='discuss.channel'
        AND m.res_id=c.id AND m.message_type!='user_notification' AND n.res_partner_id=$1 AND n.is_read IS NOT TRUE) needaction,
      EXISTS(SELECT 1 FROM discuss_call_history h WHERE h.channel_id=c.id AND h.end_dt IS NULL) ongoing
    FROM discuss_channel c LEFT JOIN discuss_channel p ON p.id=c.parent_channel_id
    LEFT JOIN discuss_channel_member cm ON cm.channel_id=c.id AND cm.partner_id=$1
    WHERE NOT (c.id = ANY($2::int[]))`,[self.partnerId,exclude,subtype,tz])).rows;
  const today=todayInTz(await dbNow(env),tz);
  const video=(c:LoadMoreCandidate)=>c.default_display_mode==='video_full_screen';
  const matches=(c:LoadMoreCandidate):boolean=>{
    const inTab=tab==='chat'?['chat','group'].includes(c.channel_type)&&!video(c)&&c.pinned
      :tab==='channel'?c.channel_type==='channel'&&(c.pinned||(flags.isInternal&&c.needaction))
      :c.channel_type==='group'&&c.pinned&&(video(c)||c.parent_display==='video_full_screen');
    return inTab&&filters.every(f=>{
      switch(f){
        case 'chat_unread':case 'channel_unread':case 'meeting_unread':return c.unread;
        case 'chat_group':return c.channel_type==='group';
        case 'channel_thread':case 'meeting_thread':return c.parent_channel_id!==null;
        case 'meeting_today':return video(c)&&c.create_day===today;
        default:return false;
      }
    });
  };
  const candidates=rows.filter(matches);
  const priority=(c:LoadMoreCandidate)=>c.favorite||(tab==='meeting'&&video(c)&&c.ongoing);
  const model=env.model('discuss.channel'),order='last_interest_dt DESC, id DESC';
  const domain=(ids:number[])=>term?and([cond('id','in',ids),cond('name','ilike',term)]):cond('id','in',ids);
  const first=await model.search(domain(candidates.filter(priority).map(c=>c.id)),{order,limit});
  const rest=limit-first.length>0?await model.search(domain(candidates.filter(c=>!first.includes(c.id)).map(c=>c.id)),{order,limit:limit-first.length}):[];
  const ids=[...first,...rest];
  return {ids,fullyLoaded:ids.length<limit};
}

/**
 * discuss/channel.py:42-57 `has_hidden_channels`: whether the user (sudo) has a member, not pinned (`is_pinned`
 * negated: the custom SQL `IS NOT TRUE`), of an active channel.
 */
export async function hasHiddenChannels(env:Environment,store:Store):Promise<void> {
  if(env.context['guest'])throw new NotPorted('has_hidden_channels of a guest');
  const flags=await userFlags(env.cr,env.uid);
  let hidden=false;
  // res_users.py _get_current_persona: the public user has no persona (is_self is FALSE)
  if(!flags.isPublic){
    const pid=(await userInfo(env)).partnerId;
    hidden=(await env.cr.query(`SELECT 1 FROM discuss_channel_member cm JOIN discuss_channel c ON c.id=cm.channel_id
      WHERE cm.partner_id=$1 AND c.active IS TRUE
        AND (cm.unpin_dt IS NULL OR cm.last_interest_dt>=cm.unpin_dt OR c.last_interest_dt>=cm.unpin_dt) IS NOT TRUE LIMIT 1`,[pid])).rows.length>0;
  }
  store.global({has_hidden_channels:hidden});
}

/** discuss_channel.py:1957 `_get_last_messages`: the last message of each channel (ordered by channel id). */
export async function lastMessages(env:Environment,ids:readonly number[]):Promise<number[]> {
  const rows=(await env.cr.query<{mid:number|null}>(`SELECT (SELECT m.id FROM mail_message m WHERE m.model='discuss.channel' AND m.res_id=c.id ORDER BY m.id DESC LIMIT 1) AS mid
      FROM discuss_channel c WHERE c.id=ANY($1::int[]) ORDER BY c.id`,[ids])).rows;
  return rows.map(r=>r.mid).filter((m):m is number=>m!==null);
}

/** discuss/channel.py:37: channels with a needaction counter add their last needaction message (not ported). */
export async function checkNoNeedaction(env:Environment,ids:readonly number[]):Promise<void> {
  const self=await userInfo(env);
  const n=(await env.cr.query<{n:string}>(`SELECT count(*)::text n FROM mail_message m JOIN mail_notification n ON n.mail_message_id=m.id
     WHERE m.model='discuss.channel' AND m.res_id=ANY($1::int[]) AND n.res_partner_id=$2 AND NOT n.is_read`,[ids,self.partnerId])).rows[0];
  if(Number(n?.n??0)>0)throw new NotPorted('last needaction messages of channels');
}

/** init_messaging's channels serialized alone (as the request loop does when nothing else adds channels). */
export async function initChannels(env:Environment,store:Store):Promise<void> {
  await storeChannels(env,store,await initChannelIds(env));
}
