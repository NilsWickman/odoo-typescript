/** base/models/res_partner.py _compute_same_vat_partner_id, vat/type labels,
 * active languages and additional identifiers; mail/phone blacklist mixins. */
import { NotPorted } from '../errors';
import { registerHooks } from '../orm/hooks';
import { parseDomain } from '../orm/domain';
import type { Environment } from '../orm/types';
import { canonicalPhone } from './phone';

type Metadata=Record<string,Record<string,unknown>>;
interface ContactData {identifiers:Metadata;translations:Record<string,Record<string,string>>}
let data:Promise<Record<string,ContactData>>|undefined;
async function definitions(env:Environment):Promise<ContactData>{
  data??=import('../../gen/out/contacts.json',{with:{type:'json'}}).then(m=>m.default);
  const found=(await data)[env.lang||'en_US'];if(!found)throw new NotPorted(`partner form translations ${env.lang}`);return found;
}
async function label(env:Environment,source:string):Promise<string>{return (await definitions(env)).translations['base']?.[source]||source;}

/** The modules whose res.partner overrides `_get_all_additional_identifiers_metadata` or
 * `_compute_available_additional_identifiers_metadata` (grep of odoo/addons and oca, 2026-11-22): with one of them
 * installed the metadata is not base's (gen/contacts.py). Other localisations (l10n_se, l10n_be, ...) keep base's. */
export const IDENTIFIER_METADATA_OVERRIDES:ReadonlySet<string>=new Set(['l10n_ar','l10n_br','l10n_cl','l10n_co','l10n_do','l10n_ec','l10n_es','l10n_gt','l10n_nl','l10n_pa','l10n_pe','l10n_sa','l10n_tr','l10n_uy']);
export function refuseIdentifierMetadataOverride(env:Environment):void{
  const over=env.reg.model('res.partner').modules?.filter(m=>IDENTIFIER_METADATA_OVERRIDES.has(m));
  if(over?.length)throw new NotPorted(`localisation identifier metadata override (${over.join(', ')})`);
}

registerHooks('res.partner',{computed:{
  same_vat_partner_id:async(env,ids)=>{
    const rows=await env.sudo().model('res.partner').read(ids,['vat','parent_id','country_id','company_id'],'web');
    const result=new Map<number,unknown>(),Partner=env.sudo().withContext({...env.context,active_test:false}).model('res.partner');
    for(const p of rows){const id=Number(p['id']),vat=p['vat'];
      if(typeof vat!=='string'||!vat||['/','na','NA'].includes(vat)||p['parent_id']){result.set(id,false);continue;}
      const vats=[vat],country=p['country_id'];
      if(country){
        const c=(await env.sudo().model('res.country').read([Number(country)],['code','country_group_ids'],'web'))[0]!;
        const groups=await env.sudo().model('res.country.group').read(c['country_group_ids'] as number[],['code'],'web');
        if(groups.some(g=>g['code']==='EU_PREFIX')){
          if(/^\p{L}{2}/u.test(vat))vats.push(vat.slice(2));else {vats.push(`${c['code']}${vat}`);const extra:Record<string,string>={GR:'EL',GB:'XI'};if(extra[String(c['code'])])vats.push(extra[String(c['code'])]+vat);}
        }
      }
      const domain:unknown[]=[['vat','in',vats]];
      if(country)domain.push(['country_id','in',[country,false]]);
      if(p['company_id'])domain.push(['company_id','in',[false,p['company_id']]]);
      domain.push(['id','!=',id],'!',['id','child_of',id]);
      result.set(id,(await Partner.search(parseDomain(domain),{limit:1}))[0]??false);
    }return result;
  },
  vat_label:async(env,ids)=>{
    const row=(await env.cr.query<{label:string|null}>(`SELECT coalesce(c.vat_label->>$2,c.vat_label->>'en_US') label
      FROM res_company company LEFT JOIN res_partner cp ON cp.id=company.partner_id LEFT JOIN res_country c ON c.id=cp.country_id WHERE company.id=$1`,[await env.company(),env.lang||'en_US'])).rows[0];
    const value=row?.label||await label(env,'Tax ID');return new Map(ids.map(id=>[id,value]));
  },
  type_address_label:async(env,ids)=>{
    const rows=await env.sudo().model('res.partner').read(ids,['type'],'web');
    const out=new Map<number,unknown>();for(const p of rows)out.set(Number(p['id']),await label(env,p['type']==='invoice'?'Invoice Address':p['type']==='delivery'?'Delivery Address':'Address'));return out;
  },
  active_lang_count:async(env,ids)=>{const count=await env.sudo().model('res.lang').searchCount(parseDomain([['active','=',true]]));return new Map(ids.map(id=>[id,count]));},
  available_additional_identifiers_metadata:async(env,ids)=>{
    refuseIdentifierMetadataOverride(env);
    const meta=(await definitions(env)).identifiers;
    const rows=await env.sudo().model('res.partner').read(ids,['country_code','additional_identifiers'],'web');
    return new Map(rows.map(p=>{
      const stored=(p['additional_identifiers']||{}) as Record<string,unknown>;
      const selected=Object.fromEntries(Object.entries(meta).filter(([key,m])=>!m['countries']||(m['countries'] as string[]).includes(String(p['country_code']))||key in stored));
      if(Object.entries(selected).some(([k,m])=>k!=='OTHER'&&m['category']==='EN'))delete selected['OTHER'];
      return [Number(p['id']),selected];
    }));
  },
  is_blacklisted:async(env,ids)=>new Map((await env.cr.query<{id:number;value:boolean}>(`SELECT p.id,EXISTS(SELECT 1 FROM mail_blacklist b WHERE b.active AND b.email=p.email_normalized) value FROM res_partner p WHERE p.id=ANY($1::int[])`,[ids])).rows.map(r=>[r.id,r.value])),
  phone_blacklisted:async(env,ids)=>{
    const rows=(await env.cr.query<{id:number;phone:string|null;phone_sanitized:string|null;code:string|null;blacklisted:boolean}>(`SELECT p.id,p.phone,p.phone_sanitized,coalesce(c.code,cc.code) code,
      EXISTS(SELECT 1 FROM phone_blacklist b WHERE ($3=false OR b.active) AND b.number=p.phone_sanitized) blacklisted
      FROM res_partner p LEFT JOIN res_country c ON c.id=p.country_id JOIN res_company company ON company.id=$2 LEFT JOIN res_partner cp ON cp.id=company.partner_id LEFT JOIN res_country cc ON cc.id=cp.country_id
      WHERE p.id=ANY($1::int[])`,[ids,await env.company(),env.context['active_test']!==false])).rows;
    const result=new Map<number,unknown>();for(const p of rows)result.set(p.id,p.blacklisted&&(await canonicalPhone(p.phone,p.code))===p.phone_sanitized);return result;
  },
}});
