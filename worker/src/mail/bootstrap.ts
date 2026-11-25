/** mail/models/{res_users,res_partner}.py _store_init_global_fields and
 * _store_init_fields, with mail/models/discuss/res_users.py's extensions. */
import { NotPorted } from '../errors';
import { computeImStatus, type PresenceStatus } from '../bus/presence';
import { createEnvironment, userInfo } from '../orm/env';
import type { Environment } from '../orm/types';
import { parseDomain } from '../orm/domain';
import { limitedFieldAccessToken } from '../models/util';
import { registerSessionInfoHook } from '../session/info';
import { icpBool, icpInt, userFlags, xmlidToResId } from '../session/user';
import { Store } from './store';

interface Partner {id:number;active:boolean;is_company:boolean;name:string|null;partner_share:boolean;email:string|null;tz:string|null;write_date:string|null}
interface User {id:number;partner_id:number;active:boolean;share:boolean;manual_im_status:string|null;notification_type:string;signature:string|null;status:PresenceStatus|null}

export class MailBootstrap {
  private statusUsers = new Set<number>();
  constructor(readonly env:Environment, readonly store = new Store()) {}
  private async xmlid(name:string):Promise<number> {
    const id=await xmlidToResId(this.env.cr,name);
    if(id===null) throw new Error(`Missing XML id ${name}`);
    return id;
  }
  private async user(id:number):Promise<User> {
    const row=(await this.env.cr.query<User>(`SELECT u.id,u.partner_id,u.active,u.share,u.manual_im_status,u.notification_type,u.signature,p.status
      FROM res_users u LEFT JOIN mail_presence p ON p.user_id=u.id WHERE u.id=$1`,[id])).rows[0];
    if(!row) throw new Error(`Missing res.users ${id}`);
    return row;
  }
  /** Message authors expose only avatar/name/company and the main user's identity. */
  async author(id:number):Promise<void>{
    // the reads below are issued with the avatar's, so they share its round trip (src/db.ts pipelining); the Store
    // is filled in the same order as before
    const rowP=this.env.cr.query<{is_company:boolean}>('SELECT is_company FROM res_partner WHERE id=$1',[id]);
    const selfP=this.user(this.env.uid);
    const usersP=this.env.cr.query<{id:number}>('SELECT id FROM res_users WHERE partner_id=$1 AND active ORDER BY share,id',[id]);
    for(const p of [rowP,selfP,usersP])p.catch(()=>undefined);
    await this.avatar(id);
    const row=(await rowP).rows[0]!;
    const self=await selfP;
    const users=(await usersP).rows;
    const main=self.partner_id===id?self.id:users[0]?.id??(id===await this.xmlid('base.partner_root')?await this.xmlid('base.user_root'):false);
    this.store.add('res.partner',id,{is_company:row.is_company===true,main_user_id:main});
    if(main){const u=await this.user(main);this.store.add('res.users',main,{partner_id:id,share:u.share});}
  }
  async avatar(id:number):Promise<void>{
    const row=(await this.env.cr.query<{name:string|null;write_date:string|null}>(`SELECT name,to_char(write_date,'YYYY-MM-DD HH24:MI:SS') write_date FROM res_partner WHERE id=$1`,[id])).rows[0]!;
    this.store.add('res.partner',id,{name:row.name||false,write_date:row.write_date??false,avatar_128_access_token:await limitedFieldAccessToken(this.env,'res.partner',id,'avatar_128','binary')});
  }
  /** mail_guest.py:157-159 `_store_avatar_fields`: the avatar's access token, name and write_date. */
  async guestAvatar(id:number):Promise<void>{
    const row=(await this.env.cr.query<{name:string|null;write_date:string|null}>(`SELECT name,to_char(write_date,'YYYY-MM-DD HH24:MI:SS') write_date FROM mail_guest WHERE id=$1`,[id])).rows[0];
    if(!row)throw new Error(`Missing mail.guest ${id}`);
    this.store.add('mail.guest',id,{avatar_128_access_token:await limitedFieldAccessToken(this.env,'mail.guest',id,'avatar_128','binary'),name:row.name||false,write_date:row.write_date??false});
  }
  async partner(id:number,full:boolean):Promise<void> {
    const {env,store}=this;
    // issued together: one round trip (src/db.ts pipelining)
    const rowP=env.cr.query<Partner>(`SELECT id,active,is_company,name,partner_share,email,tz,to_char(write_date,'YYYY-MM-DD HH24:MI:SS') AS write_date FROM res_partner WHERE id=$1`,[id]);
    const selfP=this.user(env.uid);
    const usersP=env.cr.query<{id:number}>('SELECT id FROM res_users WHERE partner_id=$1 AND active ORDER BY share,id',[id]);
    for(const p of [selfP,usersP])p.catch(()=>undefined);
    const row=(await rowP).rows[0];
    if(!row) throw new Error(`Missing res.partner ${id}`);
    const self=await selfP;
    const users=(await usersP).rows.map(u=>u.id);
    // base/res_partner.py _compute_main_user_id: self first, internal users,
    // lowest id, with the archived root user retained for OdooBot.
    const main=self.partner_id===id ? self.id : users[0] ?? (id===await this.xmlid('base.partner_root') ? await this.xmlid('base.user_root') : false);
    const flags=await userFlags(env.cr,env.uid);
    store.add('res.partner',id,{
      active:row.active===true,name:row.name||false,main_user_id:main,
      avatar_128_access_token:await limitedFieldAccessToken(env,'res.partner',id,'avatar_128','binary'),
      write_date:row.write_date??false,
      ...(full?{is_company:row.is_company===true,partner_share:row.partner_share===true}:{}),
      ...(full&&flags.isInternal?{email:row.email||false}:{}),
      ...(!full||flags.isInternal?{tz:row.tz||false}:{}),
    });
    if(main){const user=await this.user(main);store.add('res.users',main,{partner_id:id,...(full?{active:user.active,share:user.share}:{})});}
    if(flags.isInternal||!full) {
      // user_ids keeps the environment's active_test and native res.users order.
      const ordered=(await env.cr.query<{id:number}>(`SELECT id FROM res_users WHERE partner_id=$1 AND ($2=false OR active) ORDER BY login`,[id,env.context['active_test']!==false])).rows.map(u=>u.id);
      store.add('res.partner',id,{user_ids:ordered});
      for(const uid of ordered) await this.status(uid);
    }
  }
  async status(id:number):Promise<void> {
    if(this.statusUsers.has(id))return;
    this.statusUsers.add(id);
    const u=await this.user(id);
    this.store.add('res.users',id,{partner_id:u.partner_id,im_status:computeImStatus(u,u.status),
      im_status_access_token:await limitedFieldAccessToken(this.env,'res.users',id,'im_status','mail.presence')});
    const related=(await this.env.cr.query<{id:number}>('SELECT id FROM res_users WHERE partner_id=$1 AND ($2=false OR active) ORDER BY login',[u.partner_id,this.env.context['active_test']!==false])).rows.map(u=>u.id);
    this.store.add('res.partner',u.partner_id,{user_ids:related});
    for(const uid of related) await this.status(uid);
  }
  async init(settingsId:number):Promise<Store> {
    const {env,store}=this, flags=await userFlags(env.cr,env.uid), info=await userInfo(env);
    const canned=await env.sudo().model('mail.canned.response').searchCount(parseDomain(['|',['create_uid','=',env.uid],['group_ids','in',info.groupIds]]),1);
    store.global({
      action_discuss_id:await this.xmlid('mail.action_discuss'),emailActivityTypeId:await this.xmlid('mail.mail_activity_data_email'),
      hasLinkPreviewFeature:(await icpInt(env.cr,'mail.link_preview_throttle',99))>0,
      internalUserGroupId:await this.xmlid('base.group_user'),
      mt_comment:await this.xmlid('mail.mt_comment'),mt_important_notification:await this.xmlid('mail.mt_important_notification'),mt_note:await this.xmlid('mail.mt_note'),
      hasGifPickerFeature:await icpBool(env.cr,'discuss.use_klipy_api'),hasMessageTranslationFeature:await icpBool(env.cr,'mail.use_google_translate_api'),
      hasCannedResponses:canned>0,channel_types_with_seen_infos:['chat','group'],
      odoobot:await this.xmlid('base.partner_root'),
    });
    await this.partner(await this.xmlid('base.partner_root'),true);
    if(!flags.isPublic) {
      const user=await this.user(env.uid);
      store.global({self_user:env.uid});
      await this.partner(user.partner_id,false);
      store.add('res.users',env.uid,{is_admin:flags.isAdmin,notification_type:user.notification_type,share:user.share,
        signature:user.signature?['markup',user.signature]:false,res_users_settings_id:settingsId});
      await this.status(env.uid);
      const settings=(await env.cr.query<{channel_notifications:string|null}>('SELECT channel_notifications FROM res_users_settings WHERE id=$1 AND user_id=$2',[settingsId,env.uid])).rows[0];
      if(!settings)throw new NotPorted('mail bootstrap without user settings');
      const volumes=(await env.cr.query<{id:number;guest_id:number|null;partner_id:number|null;user_setting_id:number;volume:number|null}>('SELECT id,guest_id,partner_id,user_setting_id,volume FROM res_users_settings_volumes WHERE user_setting_id=$1 ORDER BY id',[settingsId])).rows;
      store.add('res.users.settings',settingsId,{channel_notifications:settings.channel_notifications??false,volume_settings_ids:volumes.map(v=>v.id)});
      for(const v of volumes) store.add('res.users.settings.volumes',v.id,{guest_id:v.guest_id??false,partner_id:v.partner_id??false,user_setting_id:v.user_setting_id,volume:v.volume??0});
    }
    if(env.context['guest'])throw new NotPorted('mail bootstrap guest');
    return store;
  }
}

registerSessionInfoHook(async(req,_user,_flags,info)=>{
  let context={...req.session.context};
  const cids=req.cookies.get('cids');
  if(cids){const env=await createEnvironment({cr:req.cr,uid:req.uid,context});const allowed=(await userInfo(env)).companyIds;context={...context,allowed_company_ids:cids.split('-').map(Number).filter(id=>allowed.includes(id))};}
  const env=await createEnvironment({cr:req.cr,uid:req.uid,context});
  const settings=info['user_settings'] as {id:number};
  info['storeData']=await(await new MailBootstrap(env).init(settings.id)).asDict(req.cr);
});
